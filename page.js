// Runs in the PAGE world (world: "MAIN") so it can read the Nuxt/Pinia store.
// The table only renders names / NR numbers; temp ids (T...), NR db ids and the
// account id live in the store. content.js asks via a DOM event, we answer via
// another DOM event. Both payloads are JSON strings (primitives cross worlds cleanly).
(() => {
  if (window.__bcregOpenInTabHook) return; // guard against double registration
  window.__bcregOpenInTabHook = true;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toUpperCase();

  // Static external URLs come from Nuxt runtime config when readable, else these fallbacks
  // (same values in dev/test/prod, see business-registry-dashboard .env).
  const URL_FALLBACKS = {
    corpOLUrl: "https://www.corporateonline.gov.bc.ca",
    societiesUrl: "https://www.bcregistry.ca/societies/",
    corpFormsUrl: "https://www2.gov.bc.ca/gov/content/employment-business/business/managing-a-business/permits-licences/businesses-incorporated-companies/forms-corporate-registry",
    llpFormsUrl: "https://www2.gov.bc.ca/assets/gov/employment-business-and-economic-development/business-management/permits-licences-and-registration/registries-packages/pack_01_llp_-_registration_forms_package.pdf",
    lpFormsUrl: "https://www2.gov.bc.ca/assets/gov/employment-business-and-economic-development/business-management/permits-licences-and-registration/registries-forms/reg_791_-_declaration_for_bc_limited_partnership.pdf",
    xlpFormUrl: "https://www2.gov.bc.ca/assets/gov/employment-business-and-economic-development/business-management/permits-licences-and-registration/registries-forms/reg_790_-_declaration_for_extraprovincial_limited_partnership.pdf",
    stepsToRestoreUrl: "https://www2.gov.bc.ca/gov/content/employment-business/business/managing-a-business/permits-licences/businesses-incorporated-companies/incorporated-companies#restore"
  };
  function runtimeUrls(app) {
    const pub = (window.__NUXT__ && window.__NUXT__.config && window.__NUXT__.config.public) ||
      (app && app.config.globalProperties.$config && app.config.globalProperties.$config.public) || {};
    const out = {};
    for (const k of Object.keys(URL_FALLBACKS)) out[k] = (typeof pub[k] === "string" && pub[k]) || URL_FALLBACKS[k];
    return out;
  }

  function stores() {
    const app = document.querySelector("#__nuxt") && document.querySelector("#__nuxt").__vue_app__;
    const state = app && app.config.globalProperties.$pinia && app.config.globalProperties.$pinia.state.value;
    if (!state) return null;
    return {
      app,
      aff: state["brd-affiliations-store"],
      acct: state["nuxt-core-connect-account-store"]
    };
  }

  const ID_RE = /^[A-Z]{1,3}\d{6,8}$/;
  const isTemp = (r) => /^T/.test(r.businessIdentifier || "") && !ID_RE.test(r.businessIdentifier || "");
  // Type cell text -> temp corpType code (TMP=IA, ATMP=amalgamation, RTMP=registration, CTMP=continuation in)
  function tempTypeFor(typeCell) {
    const t = norm(typeCell);
    if (t.startsWith("AMALGAMATION")) return "ATMP";
    if (t.startsWith("REGISTRATION")) return "RTMP";
    if (t.startsWith("CONTINUATION")) return "CTMP";
    if (t.startsWith("INCORPORATION")) return "TMP";
    return "";
  }

  // ordinal = how many earlier table rows show the same name+number+type cells; used to
  // tell apart duplicates (e.g. several "Numbered Limited Company" drafts with no number).
  function findRecord(results, nameCell, numberCell, typeCell, ordinal) {
    const num = norm(numberCell);
    const name = norm(nameCell);
    const idsOf = (r) => [r.businessIdentifier, r.nameRequest && r.nameRequest.nrNumber, r.nrNumber]
      .filter(Boolean).map(norm);
    const exact = (r) => norm(r.name) && norm(r.name) === name;
    const loose = (r) => norm(r.name) && name.includes(norm(r.name));
    const nameMatch = results.some(exact) ? exact : loose;
    let cands;
    if (num) {
      cands = results.filter((r) => idsOf(r).includes(num));
      if (cands.length > 1 && cands.some(nameMatch)) cands = cands.filter(nameMatch);
    } else {
      // Real businesses and NRs always show a number; a blank Number cell means a temp draft.
      cands = results.filter((r) => isTemp(r) && nameMatch(r));
      const code = tempTypeFor(typeCell);
      if (code && cands.some((r) => r.corpType && r.corpType.code === code)) {
        cands = cands.filter((r) => r.corpType && r.corpType.code === code);
      }
    }
    if (!cands.length) cands = results.filter(nameMatch);
    return cands[ordinal || 0] || cands[0] || null;
  }

  // The table renders store results in order (rows are appended as pages load), so the
  // row index is the most reliable key. Verify against the visible cells before trusting it.
  function verifies(r, numberCell) {
    if (!r) return false;
    const num = norm(numberCell);
    const ids = [r.businessIdentifier, r.nameRequest && r.nameRequest.nrNumber, r.nrNumber].filter(Boolean).map(norm);
    return num ? ids.includes(num) : isTemp(r);
  }

  document.addEventListener("bcreg:lookup", (e) => {
    let out = { found: false };
    try {
      const { nameCell, numberCell, typeCell, ordinal, rowIndex } = JSON.parse(e.detail);
      const s = stores();
      const results = (s && s.aff && s.aff.affiliations && s.aff.affiliations.results) || [];
      const byIndex = Number.isInteger(rowIndex) ? results[rowIndex] : null;
      const r = verifies(byIndex, numberCell) ? byIndex : findRecord(results, nameCell, numberCell, typeCell, ordinal);
      if (r) {
        out = {
          found: true,
          identifier: r.businessIdentifier || "",
          name: r.name || "",
          corpType: (r.corpType && r.corpType.code) || "",
          nrId: (r.nameRequest && r.nameRequest.id) || null,
          nrNumber: (r.nameRequest && r.nameRequest.nrNumber) || r.nrNumber || "",
          nrState: (r.nameRequest && r.nameRequest.state) || "",
          nrAction: (r.nameRequest && r.nameRequest.requestActionCd) || "",
          // mirrors getEntityType(): NR legalType wins, else corpType code
          legalType: (r.nameRequest && r.nameRequest.legalType) || (r.corpType && r.corpType.code) || "",
          isLoadedLear: r.isLoadedLear,
          // mirrors affiliationStatus(): NR counts as Approved for the primary action when
          // APPROVED with an expiry date, or CONDITIONAL with consent received/waived/not required
          nrApproved: !!r.nameRequest && (
            (r.nameRequest.state === "APPROVED" && !!r.nameRequest.expirationDate) ||
            (r.nameRequest.state === "CONDITIONAL" && [null, "R", "N"].includes(r.nameRequest.consentFlag))
          ),
          accountId: (s.acct && s.acct.currentAccount && s.acct.currentAccount.id) || null,
          urls: runtimeUrls(s.app)
        };
      }
    } catch (err) {
      out = { found: false, error: String(err) };
    }
    document.dispatchEvent(new CustomEvent("bcreg:result", { detail: JSON.stringify(out) }));
  });

  // ---- "Register Now" / "Amalgamate Now" / "Continue In Now" ----
  // Mirrors createNamedBusiness() in app/utils/business.ts: build the draft filing body from the
  // NR and POST it through the app's own $businessApi (same base URL, token, headers as the UI).
  // The UI's failure path (deleting the NR affiliation) is intentionally NOT replicated.
  function preferredName(names) {
    const approved = (names || []).find((n) => n.state === "APPROVED" || n.state === "CONDITIONAL");
    return (approved || (names || [])[0] || {}).name;
  }

  function buildFilingBody(r, filingType, accountId) {
    const nr = r.nameRequest;
    const header = { accountId: Number(accountId), name: filingType };
    const business = { legalType: nr.legalType };
    const nameRequest = { legalType: nr.legalType, nrNumber: nr.nrNumber, legalName: preferredName(nr.names) };
    switch (filingType) {
      case "amalgamationApplication":
        return { filing: { business, header, amalgamationApplication: {
          type: "regular",
          nameRequest: { ...nameRequest, nrNumber: r.businessIdentifier || nr.nrNumber } } } };
      case "incorporationApplication": {
        const body = { filing: { business, header, incorporationApplication: {
          nameRequest: { ...nameRequest, nrNumber: r.businessIdentifier || nr.nrNumber } } } };
        return body;
      }
      case "registration": {
        const registration = { business: { natureOfBusiness: nr.natureOfBusiness }, nameRequest };
        if (nr.entityTypeCd === "FR") registration.businessType = "SP";
        else if (nr.entityTypeCd === "DBA") registration.businessType = "DBA";
        return { filing: { business, header, registration } };
      }
      case "continuationIn":
        return { filing: { business, header, continuationIn: { nameRequest } } };
      default:
        throw new Error("Unknown filingType " + filingType);
    }
  }

  document.addEventListener("bcreg:create", async (e) => {
    let reqId = null;
    let out;
    try {
      const req = JSON.parse(e.detail);
      reqId = req.reqId;
      const s = stores();
      const gp = s && s.app && s.app.config.globalProperties;
      if (!gp || typeof gp.$businessApi !== "function") throw new Error("$businessApi not available on page");
      const results = (s.aff && s.aff.affiliations && s.aff.affiliations.results) || [];
      const r = results[req.rowIndex];
      if (!r || !r.nameRequest || norm(r.nameRequest.nrNumber) !== norm(req.nrNumber)) {
        throw new Error("Row no longer matches " + req.nrNumber + " (table changed?)");
      }
      const accountId = s.acct && s.acct.currentAccount && s.acct.currentAccount.id;
      const body = buildFilingBody(r, req.filingType, accountId);
      const resp = await gp.$businessApi("/businesses?draft=true", { method: "POST", body });
      const identifier = resp && resp.filing && resp.filing.business && resp.filing.business.identifier;
      if (!identifier) throw new Error("No identifier in response: " + JSON.stringify(resp).slice(0, 300));
      out = { reqId, identifier, accountId };
      // best effort: refresh the table so the new draft shows up
      try {
        const store = gp.$pinia && gp.$pinia._s && gp.$pinia._s.get("brd-affiliations-store");
        if (store && typeof store.loadAffiliations === "function") store.loadAffiliations();
      } catch (_) { /* ignore */ }
    } catch (err) {
      const data = err && err.data ? JSON.stringify(err.data).slice(0, 300) : "";
      out = { reqId, error: String(err && err.message || err) + (data ? " " + data : "") };
    }
    document.dispatchEvent(new CustomEvent("bcreg:created", { detail: JSON.stringify(out) }));
  });
})();
