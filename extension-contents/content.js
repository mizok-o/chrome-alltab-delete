chrome.action.onClicked.addListener(() => {
  function deleting(tabId) {
    const lenth = tabId.length - 1
    for(let i = lenth; i > 0; i--){
      chrome.tabs.remove(tabId[i].id)
    }
  }
  function onError(error) {
    console.log(`Error: ${error}`);
  }
  const queries = chrome.tabs.query({currentWindow: true})
  queries.then(deleting, onError)
})
