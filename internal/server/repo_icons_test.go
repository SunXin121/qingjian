package server

import (
	"net/http"
	"testing"
	"time"
)

func TestRepoIconAttachmentCleanup(t *testing.T) {
	for _, trashed := range []bool{false, true} {
		name := "active"
		if trashed {
			name = "trashed"
		}
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			iconID := e.upload("icon.png", "repo-icon")
			orphanID := e.upload("orphan.png", "unused-icon")
			iconURL := fileURL(iconID, "icon.png")
			code, repo := e.do(e.admin, "POST", "/api/repos", map[string]string{"name": "Images", "icon": iconURL})
			if code != http.StatusCreated || repo["icon"] != iconURL {
				t.Fatalf("create with icon: %d %v", code, repo)
			}
			repoID := repo["id"].(string)
			if code, saved := e.do(e.admin, "GET", "/api/repos/"+repoID, nil); code != http.StatusOK || saved["icon"] != iconURL {
				t.Fatalf("saved icon: %d %v", code, saved)
			}
			if trashed {
				if code, _ := e.do(e.admin, "DELETE", "/api/repos/"+repoID, nil); code != http.StatusOK {
					t.Fatalf("trash repo: %d", code)
				}
			}
			old := time.Now().Add(-48 * time.Hour).UnixMilli()
			if _, err := e.srv.db.Exec(`UPDATE attachments SET created_at = ?`, old); err != nil {
				t.Fatal(err)
			}
			if removed, _, err := e.srv.cleanupAttachments(); err != nil || removed != 1 {
				t.Fatalf("cleanup: removed=%d err=%v", removed, err)
			}
			if code, _ := e.raw(newClient(), "GET", iconURL, nil); code != http.StatusOK {
				t.Fatalf("referenced repo icon removed: %d", code)
			}
			if code, _ := e.raw(newClient(), "GET", fileURL(orphanID, "orphan.png"), nil); code != http.StatusNotFound {
				t.Fatalf("unused icon retained: %d", code)
			}
			if trashed {
				if code, _ := e.do(e.admin, "POST", "/api/trash/repo/"+repoID+"/restore", nil); code != http.StatusOK {
					t.Fatalf("restore repo: %d", code)
				}
			}
			if code, saved := e.do(e.admin, "PATCH", "/api/repos/"+repoID, map[string]string{"icon": ""}); code != http.StatusOK || saved["icon"] != "" {
				t.Fatalf("clear icon: %d %v", code, saved)
			}
			if removed, _, err := e.srv.cleanupAttachments(); err != nil || removed != 1 {
				t.Fatalf("cleanup cleared icon: removed=%d err=%v", removed, err)
			}
			if code, _ := e.raw(newClient(), "GET", iconURL, nil); code != http.StatusNotFound {
				t.Fatalf("cleared icon retained: %d", code)
			}
		})
	}
}
