import { describe, expect, it } from 'vitest'
import { calendarMonthDays, composeDateValue, parsePickerInput, splitDateValue } from './DatePicker'

describe('date & datetime picker helpers', () => {
  it('builds a 42-day Monday-first calendar grid across month and leap-year boundaries', () => {
    // 2026-11-01 is Sunday -> 6 leading October days (Oct 26..31)
    const nov = calendarMonthDays(2026, 11)
    expect(nov).toHaveLength(42)
    expect(nov[0]).toEqual({ date: '2026-10-26', day: 26, inMonth: false })
    expect(nov[6]).toEqual({ date: '2026-11-01', day: 1, inMonth: true })
    expect(nov[35]).toEqual({ date: '2026-11-30', day: 30, inMonth: true })
    expect(nov[41]).toEqual({ date: '2026-12-06', day: 6, inMonth: false })

    // Leap year February 2024 contains Feb 29; non-leap 2026 does not
    expect(calendarMonthDays(2024, 2).some((c) => c.date === '2024-02-29' && c.inMonth)).toBe(true)
    expect(calendarMonthDays(2026, 2).some((c) => c.date === '2026-02-29')).toBe(false)
  })

  it('splits and composes date and datetime values', () => {
    expect(splitDateValue('2026-11-25')).toEqual({ day: '2026-11-25', hour: 0, minute: 0 })
    expect(splitDateValue('2026-11-25 14:35')).toEqual({ day: '2026-11-25', hour: 14, minute: 35 })
    expect(splitDateValue(undefined)).toEqual({ day: '', hour: 0, minute: 0 })

    expect(composeDateValue('', 9, 30, true)).toBeUndefined()
    expect(composeDateValue('2026-11-25', 9, 5, false)).toBe('2026-11-25')
    expect(composeDateValue('2026-11-25', 9, 5, true)).toBe('2026-11-25 09:05')
  })

  it('parses flexible date and datetime inputs while rejecting invalid calendar dates', () => {
    expect(parsePickerInput('2026/3/7', false)).toBe('2026-03-07')
    expect(parsePickerInput('2026.11.25 9:5', true)).toBe('2026-11-25 09:05')
    expect(parsePickerInput('2026年5月1日 14时30分', true)).toBe('2026-05-01 14:30')
    expect(parsePickerInput('20261125', false)).toBe('2026-11-25')
    expect(parsePickerInput('20261125 1845', true)).toBe('2026-11-25 18:45')
    expect(parsePickerInput('12/31', false, 2026)).toBe('2026-12-31')
    expect(parsePickerInput('5-4 8:30', true, 2027)).toBe('2027-05-04 08:30')

    // Rejects rolled-over or out-of-range dates/times instead of silently coercing
    expect(parsePickerInput('2026-02-29', false)).toBeUndefined()
    expect(parsePickerInput('2026-13-01', false)).toBeUndefined()
    expect(parsePickerInput('2026-11-31', false)).toBeUndefined()
    expect(parsePickerInput('2026-11-25 24:00', true)).toBeUndefined()
    expect(parsePickerInput('2026-11-25 12:60', true)).toBeUndefined()
    expect(parsePickerInput('', false)).toBeUndefined()
  })
})
