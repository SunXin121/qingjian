package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// Line-based deltas for document history. A delta rebuilds a text from a base text as a
// list of ops: [start, count] copies count lines of the base starting at line start, a
// string is inserted verbatim. Lines keep their trailing "\n", so joining is exact.
//
// The encoder works like git's pack deltas rather than a minimal diff: every line of the
// new text is looked up in an index of the base, and the longest run of matching lines
// found there is copied. That handles moved blocks as well as edits and runs in roughly
// linear time, so it stays cheap for documents with a million characters.

const (
	// candidate positions examined per line; repeated lines (blank lines, "```") have many
	deltaMaxCandidates = 16
	// a copy op costs ~12 bytes, so a single short line is cheaper to insert
	deltaMinCopyBytes = 16
)

// lines splits s after every "\n"; the last line may lack one.
func lines(s string) []string {
	if s == "" {
		return nil
	}
	out := strings.SplitAfter(s, "\n")
	if out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return out
}

// makeDelta returns the encoded delta that turns base into target.
func makeDelta(base, target string) string {
	a, b := lines(base), lines(target)
	index := make(map[string][]int, len(a))
	for i, l := range a {
		if len(index[l]) < deltaMaxCandidates {
			index[l] = append(index[l], i)
		}
	}
	var ops []any
	var ins strings.Builder
	flush := func() {
		if ins.Len() > 0 {
			ops = append(ops, ins.String())
			ins.Reset()
		}
	}
	addCopy := func(start, n int) {
		flush()
		if k := len(ops) - 1; k >= 0 {
			if c, ok := ops[k].([2]int); ok && c[0]+c[1] == start {
				ops[k] = [2]int{c[0], c[1] + n}
				return
			}
		}
		ops = append(ops, [2]int{start, n})
	}
	next := -1 // base line following the previous copy: preferred continuation
	for i := 0; i < len(b); {
		bestStart, bestLen, bestBytes := -1, 0, 0
		try := func(p int) {
			if p < 0 || p >= len(a) || a[p] != b[i] {
				return
			}
			n, nb := 0, 0
			for p+n < len(a) && i+n < len(b) && a[p+n] == b[i+n] {
				nb += len(a[p+n])
				n++
			}
			if n > bestLen || (n == bestLen && p == next) {
				bestStart, bestLen, bestBytes = p, n, nb
			}
		}
		try(next)
		for _, p := range index[b[i]] {
			if p != next {
				try(p)
			}
		}
		if bestLen > 0 && (bestBytes >= deltaMinCopyBytes || bestStart == next) {
			addCopy(bestStart, bestLen)
			i += bestLen
			next = bestStart + bestLen
			continue
		}
		ins.WriteString(b[i])
		i++
	}
	flush()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // keep text (and the /files/ links scanned for attachments) as is
	if ops == nil {
		ops = []any{}
	}
	enc.Encode(ops)
	return strings.TrimSuffix(buf.String(), "\n")
}

var errBadDelta = errors.New("版本数据损坏")

// applyDelta rebuilds the text a delta was made for from its base.
func applyDelta(base, delta string) (string, error) {
	var ops []json.RawMessage
	if err := json.Unmarshal([]byte(delta), &ops); err != nil {
		return "", errBadDelta
	}
	a := lines(base)
	var out strings.Builder
	out.Grow(len(base) + len(delta))
	for _, op := range ops {
		if len(op) > 0 && op[0] == '"' {
			var s string
			if err := json.Unmarshal(op, &s); err != nil {
				return "", errBadDelta
			}
			out.WriteString(s)
			continue
		}
		var c [2]int
		if err := json.Unmarshal(op, &c); err != nil || c[0] < 0 || c[1] < 0 || c[0]+c[1] > len(a) {
			return "", errBadDelta
		}
		for _, l := range a[c[0] : c[0]+c[1]] {
			out.WriteString(l)
		}
	}
	return out.String(), nil
}
