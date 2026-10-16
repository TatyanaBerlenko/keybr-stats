// Clicking the extension icon opens the stats page.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("stats.html") });
});
