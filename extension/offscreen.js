// Only job: turn backup text into a blob: URL the service worker can hand to chrome.downloads.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.to !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'blob') reply({ url: URL.createObjectURL(new Blob([msg.text], { type: msg.mime })) });
  if (msg.type === 'revoke') { URL.revokeObjectURL(msg.url); reply({}); }
  return false;
});
