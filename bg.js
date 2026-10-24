const MENU_IDS = ["dash", "nr", "access", "forms", "restore", "external", "register", "amalgamate", "continuein"];
const pending = {};   // menu id -> item ({url} or {create})

function createMenus() {
  for (const id of MENU_IDS) {
    browser.menus.create({
      id,
      title: id,
      contexts: ["all"],
      documentUrlPatterns: ["https://*.bcregistry.gov.bc.ca/*"],
      visible: false
    }, () => { void browser.runtime.lastError; }); // ignore "already exists" on event-page wake
  }
}
createMenus();

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "ctx") return;
  const byId = Object.fromEntries((msg.items || []).map((i) => [i.id, i]));
  for (const id of MENU_IDS) {
    const item = byId[id];
    pending[id] = item || null;
    browser.menus.update(id, {
      visible: !!item,
      title: item ? item.title : id,
      enabled: !item || !!(item.url || item.create)
    });
  }
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info, tab) => {
  const item = pending[info.menuItemId];
  if (!item) return;
  if (item.url) {
    browser.tabs.create({ url: item.url, active: false });
    return;
  }
  if (item.create && tab && tab.id != null) {
    try {
      const res = await browser.tabs.sendMessage(tab.id, { type: "create", create: item.create });
      if (res && res.url) browser.tabs.create({ url: res.url, active: false });
    } catch (err) {
      console.error("[bcreg] create failed", err);
    }
  }
});
