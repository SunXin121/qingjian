// Message IDs are an API used by chrome.i18n: brand display text only.
export function brandMessages(messages, locale) {
  return Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, {
    ...value,
    message: value.message.replaceAll('EdgeEver', locale === 'zh_CN' ? '青简' : 'Qingjian'),
  }]))
}
