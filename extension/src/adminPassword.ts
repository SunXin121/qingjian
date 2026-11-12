// Basic authentication uses the same password as Qingjian's login form.
// Encode UTF-8 before base64 so Chinese, spaces and colons remain unchanged.
export function adminPasswordAuthorization(password: string): string {
  const bytes = new TextEncoder().encode(`admin:${password}`)
  return `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`
}
