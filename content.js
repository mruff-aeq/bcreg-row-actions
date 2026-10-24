// Isolated-world content script: detects right-click on an affiliation table row,
// asks page.js for the store record, builds "open in new tab" targets, sends to bg.js.
const m = location.hostname.match(/^((?:dev|test)\.)?/);
const ENV = (m && m[1]) || "";
const DASHBOARD = `https://${ENV}business-dashboard.bcregistry.gov.bc.ca`;
const NAMES = `https://${ENV}names.bcregistry.gov.bc.ca`;
const ID_RE = /^[A-Z]{1,3}\d{6,8}$/;
// Mirrors business-registry-dashboard app/utils/business.ts
const OTHER_ENTITIES = ["FI", "PA", "PAR", "LL", "LP", "XP"];          // isOtherEntities -> "Download Form"
const SOCIETIES = ["S", "CS", "XS"];                                   // isSocieties -> Societies Online
const RESTORABLE = ["BC", "CC", "ULC", "CP", "BEN", "C", "CBEN", "CCC", "CUL"]; // isForRestore vs reinstate
const NR_RESTORE = ["REH", "REN"];                                     // NrRequestActionCodes RESTORE / RENEW
const REGISTRATION_TYPES = ["SP", "GP"];                               // registration vs incorporation application
const CREATE_ENABLED = /^(dev|test)\./.test(location.hostname);        // draft-creating actions: dev/test only

function rowFor(start) {
  const tr = start && start.closest ? start.closest("table tbody tr") : null;
  return tr && tr.querySelectorAll("td").length >= 2 ? tr : null;
}

function cellsOf(tr) {
  const text = (td) => td.textContent.replace(/\s+/g, " ").trim();
  const ths = [...(tr.closest("table") || tr).querySelectorAll("thead th")].map((th) => th.textContent.trim().toLowerCase());
  const idx = (pred, fallback) => { const i = ths.findIndex(pred); return i >= 0 ? i : fallback; };
  const iName = idx((h) => h.startsWith("business name") || h === "name", 0);
  const iNum = idx((h) => h.startsWith("number"), 1);
  const iType = idx((h) => h.startsWith("type"), 2);
  const read = (row) => {
    const tds = [...row.querySelectorAll("td")].map(text);
    return { nameCell: tds[iName] || "", numberCell: tds[iNum] || "", typeCell: tds[iType] || "" };
  };
  const cells = read(tr);
  // Count earlier rows with identical name+number+type so duplicates resolve to distinct records.
  let ordinal = 0;
  for (let prev = tr.previousElementSibling; prev; prev = prev.previousElementSibling) {
    const p = read(prev);
    if (p.nameCell === cells.nameCell && p.numberCell === cells.numberCell && p.typeCell === cells.typeCell) ordinal++;
  }
  cells.ordinal = ordinal;
  cells.rowIndex = [...tr.parentElement.children].indexOf(tr);
  return cells;
}

function lookup(cells) {
  let result = null;
  const onResult = (e) => { try { result = JSON.parse(e.detail); } catch (_) { result = null; } };
  document.addEventListener("bcreg:result", onResult, { once: true });
  document.dispatchEvent(new CustomEvent("bcreg:lookup", { detail: JSON.stringify(cells) }));
  document.removeEventListener("bcreg:result", onResult);
  return result;
}

function buildItems(cells, rec) {
  const acct = (rec && rec.accountId) || new URLSearchParams(location.search).get("accountid") || "";
  const q = acct ? `?accountid=${acct}` : "";
  const items = [];
  const identifier = (rec && rec.identifier) || (ID_RE.test(cells.numberCell) ? cells.numberCell : "");
  const isTemp = /^T/.test(identifier) && !ID_RE.test(identifier);

  // No dashboard for businesses not loaded in LEAR (UI sends them to Corporate Online) or for
  // societies (UI sends them to Societies Online).
  const noDashboard = !!rec && (rec.isLoadedLear === false || SOCIETIES.includes(rec.legalType));
  if (identifier && !noDashboard) {
    items.push({
      id: "dash",
      title: isTemp ? `Open draft ${identifier} in new tab` : `Open ${identifier} dashboard in new tab`,
      url: `${DASHBOARD}/${identifier}${q}`
    });
  }
  if (rec && rec.nrId) {
    items.push({
      id: "nr",
      title: `Open ${rec.nrNumber || "name request"} in new tab`,
      url: `${NAMES}/nr/${rec.nrId}${q}`
    });
  }
  if (identifier && !isTemp) {
    items.push({
      id: "access",
      title: `Open View Access for ${identifier} in new tab`,
      url: `${location.origin}/business/${identifier}/viewAccess`
    });
  }

  if (rec) {
    const u = rec.urls || {};
    const isNr = !!rec.nrId && !identifier;
    const approvedNew = isNr && rec.nrState === "APPROVED" && rec.nrAction === "NEW";

    // "Download Form": approved NEW name request for a forms-only entity type.
    if (approvedNew && OTHER_ENTITIES.includes(rec.legalType)) {
      const formUrl = { LL: u.llpFormsUrl, LP: u.lpFormsUrl, XP: u.xlpFormUrl }[rec.legalType] || u.corpFormsUrl;
      items.push({ id: "forms", title: `Open ${rec.legalType} registration forms in new tab`, url: formUrl });
    }

    // "Steps to Restore" / "Steps to Reinstate": restore or renew name request (static help page).
    if (isNr && NR_RESTORE.includes(rec.nrAction)) {
      const word = RESTORABLE.includes(rec.legalType) ? "Restore" : "Reinstate";
      items.push({ id: "restore", title: `Open Steps to ${word} in new tab`, url: u.stepsToRestoreUrl });
    }

    // "Register Now" / "Amalgamate Now" / "Continue In Now": same as the UI button, creates the
    // draft filing from the NR via the app's API, then opens the new temp id in a new tab.
    if (CREATE_ENABLED && isNr && rec.nrApproved && rec.nrNumber) {
      const create = (id, filingType, verb) => items.push({
        id,
        title: `${verb}: create draft from ${rec.nrNumber} and open in new tab`,
        create: { rowIndex: cells.rowIndex, nrNumber: rec.nrNumber, filingType }
      });
      if (rec.nrAction === "NEW" && !OTHER_ENTITIES.includes(rec.legalType) && !SOCIETIES.includes(rec.legalType)) {
        const isReg = REGISTRATION_TYPES.includes(rec.legalType);
        create("register", isReg ? "registration" : "incorporationApplication", isReg ? "Register Now" : "Incorporate Now");
      } else if (rec.nrAction === "AML") {
        create("amalgamate", "amalgamationApplication", "Amalgamate Now");
      } else if (rec.nrAction === "MVE") {
        create("continuein", "continuationIn", "Continue In Now");
      }
    }

    // External "Manage Business" / "Register Now": Societies Online or Corporate Online.
    if (SOCIETIES.includes(rec.legalType) && (!isNr || approvedNew)) {
      items.push({ id: "external", title: "Open Societies Online in new tab", url: `${u.societiesUrl}${q}` });
    } else if (identifier && !isTemp && rec.isLoadedLear === false) {
      items.push({ id: "external", title: `Open ${identifier} in Corporate Online (new tab)`, url: `${u.corpOLUrl}${q}` });
    }
  }
  return items;
}

// bg.js asks us to create the draft when a create item is clicked; resolve with the dashboard URL.
function createDraft(create) {
  return new Promise((resolve) => {
    const reqId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { done({ error: "Timed out waiting for the app" }); }, 45000);
    const onCreated = (e) => {
      let out = null;
      try { out = JSON.parse(e.detail); } catch (_) { return; }
      if (!out || out.reqId !== reqId) return;
      done(out);
    };
    const done = (out) => {
      clearTimeout(timer);
      document.removeEventListener("bcreg:created", onCreated);
      if (out.error) {
        console.error("[bcreg] create draft failed:", out.error);
        window.alert(`Create draft failed:\n${out.error}`);
        resolve({ error: out.error });
        return;
      }
      const acct = out.accountId || new URLSearchParams(location.search).get("accountid") || "";
      resolve({ url: `${DASHBOARD}/${out.identifier}${acct ? `?accountid=${acct}` : ""}` });
    };
    document.addEventListener("bcreg:created", onCreated);
    document.dispatchEvent(new CustomEvent("bcreg:create", { detail: JSON.stringify({ reqId, ...create }) }));
  });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "create" && msg.create) return createDraft(msg.create);
});

document.addEventListener("contextmenu", (e) => {
  const tr = rowFor(e.target);
  let items = [];
  if (tr) {
    const cells = cellsOf(tr);
    const rec = lookup(cells);
    items = buildItems(cells, rec);
    if (!items.length) {
      items.push({ id: "dash", title: "Open in new tab (no identifier found, see console)", url: null });
      console.log("[bcreg] no identifier for row", cells, rec);
    }
  }
  browser.runtime.sendMessage({ type: "ctx", items });
}, true);
