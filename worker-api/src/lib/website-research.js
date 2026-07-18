/**
 * Bounded first-party website research. This module stores observations, not
 * raw pages, and never treats an absence detector as proof of business harm.
 */

const EXECUTIVE_TITLE = /\b(owner|co[- ]?founder|founder|chief executive(?: officer)?|ceo|president|principal|managing (?:partner|director|member)|general manager|partner)\b/i;
const CTA_WORDS = /\b(contact|book|schedule|request|quote|estimate|consult|consultation|get started|start here|call now|talk to|shop now|buy now|order)\b/i;
const BOOKING_WORDS = /\b(book|booking|schedule|appointment|calendar|calendly|acuity|setmore|squareup\.com\/appointments)\b/i;
const CHAT_WORDS = /\b(intercom|drift|tawk\.to|crisp\.chat|hubspot-messages|livechat|zendesk|chatwoot)\b/i;
const CONTACT_PAGE_PATH = /(?:^|\/)(?:contact(?:-us)?|get-in-touch|reach-us)(?:\/|\.(?:html?|aspx?)|$)/i;
const RESEARCH_CATEGORY_ORDER = ["contact", "people", "careers", "services"];
const COPY_ROLE_WORDS = /\b(?:(?:senior|sr\.?|junior|jr\.?|lead|principal|contract|freelance|seo\s*&\s*aeo)\s+)?(copywriter|copy writer|content writer|content strategist|content marketing (?:manager|specialist|director|lead)|lifecycle marketing (?:manager|specialist|director|lead)|email marketing (?:manager|specialist|director|lead)|growth marketing (?:manager|specialist|director|lead)|brand writer|creative writer)\b/i;
const COPY_ROLE_CONTEXT = /\b(?:hiring|seeking|looking for|open (?:role|position|opening)|join (?:our )?team|apply(?:ing)? for|job opening)\b/i;
const PUBLIC_JOB_HOSTS = new Set([
  "jobs.lever.co", "boards.greenhouse.io", "job-boards.greenhouse.io",
  "apply.workable.com", "jobs.ashbyhq.com",
]);

// These markers are deliberately limited to provider-specific embed syntax.
// A plain link to a hosted form is not treated as a form embedded on the page.
const EMBEDDED_FORM_PATTERNS = [
  /\bhbspt\.forms\.create\s*\(/i,
  /<script\b[^>]+src\s*=\s*["'][^"']*js\.hsforms\.net\/forms\/(?:embed|v2)\.js/i,
  /\bdata-tf-(?:live|widget)\s*=/i,
  /<iframe\b[^>]+(?:src|data-src)\s*=\s*["'][^"']*(?:form\.typeform\.com\/to\/|form\.jotform\.com\/|jotform\.com\/jsform\/|docs\.google\.com\/forms\/d\/e\/[^/]+\/viewform|tally\.so\/embed\/|cognitoforms\.com\/f\/)/i,
  /\b(?:JotFormIFrame|Cognito\.load|Formstack\.Forms\.create)\s*\(/i,
];

export function safeResearchUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: false, error: "website-missing" };
  let url;
  try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); }
  catch { return { ok: false, error: "website-invalid" }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { ok: false, error: "website-unsafe" };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (unsafeHostname(hostname)) return { ok: false, error: "website-unsafe" };
  url.hash = "";
  return { ok: true, url, hostname };
}

export function analyzeHtml(html, sourceUrl, nowYear = new Date().getUTCFullYear()) {
  const bounded = String(html || "");
  const title = cleanText(firstMatch(bounded, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  const metaDescription = cleanText(
    firstMatch(bounded, /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i)
    || firstMatch(bounded, /<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["'][^>]*>/i),
  );
  const primaryHeading = cleanText(firstMatch(bounded, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i));
  const visibleText = htmlToText(bounded);
  const links = extractLinks(bounded, sourceUrl);
  const hasViewport = /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(bounded);
  const hasNativeForm = /<form\b/i.test(bounded);
  const hasEmbeddedForm = EMBEDDED_FORM_PATTERNS.some((pattern) => pattern.test(bounded));
  const hasForm = hasNativeForm || hasEmbeddedForm;
  const hasPrimaryCta = links.some((link) => CTA_WORDS.test(`${link.text} ${link.href}`))
    || /<(?:button|input)\b[^>]*(?:value|aria-label)\s*=\s*["'][^"']*(?:contact|book|schedule|quote|estimate|get started)/i.test(bounded);
  const hasBookingPath = links.some((link) => BOOKING_WORDS.test(`${link.text} ${link.href}`))
    || BOOKING_WORDS.test(bounded);
  const hasPhonePath = links.some((link) => link.href.startsWith("tel:"));
  const hasEmailPath = links.some((link) => link.href.startsWith("mailto:"));
  const hasChatPath = CHAT_WORDS.test(bounded);
  const hasContactPage = isContactPageUrl(sourceUrl)
    || links.some((link) => isSameSiteContactPageLink(link, sourceUrl));
  const copyrightYears = [...visibleText.matchAll(/(?:©|copyright)\s*(?:19|20)(\d{2})/ig)]
    .map((match) => Number(`20${match[1]}`)).filter((year) => year >= 1990 && year <= nowYear);
  const copyrightYear = copyrightYears.length ? Math.max(...copyrightYears) : null;
  return {
    source_url: sourceUrl,
    title: title.slice(0, 200),
    meta_description: metaDescription.slice(0, 500),
    primary_heading: primaryHeading.slice(0, 300),
    has_viewport: hasViewport,
    has_form: hasForm,
    has_native_form: hasNativeForm,
    has_embedded_form: hasEmbeddedForm,
    has_primary_cta: hasPrimaryCta,
    has_booking_path: hasBookingPath,
    has_phone_path: hasPhonePath,
    has_email_path: hasEmailPath,
    has_chat_path: hasChatPath,
    has_contact_page: hasContactPage,
    copyright_year: copyrightYear,
    internal_links: links.filter((link) => /^https?:/i.test(link.href)),
    public_job_links: links.filter((link) => publicJobBoardUrl(link.href)).map((link) => link.href),
    copy_role_mentions: extractCopyRoleMentions(bounded, sourceUrl),
    contacts: extractContactPaths(links, sourceUrl),
    decision_makers: extractDecisionMakers(bounded, visibleText, links, sourceUrl),
    visible_text: visibleText.slice(0, 20_000),
  };
}

export async function researchOfficialWebsite({
  domain,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  maxBytes = 1_000_000,
  maxPages = 4,
  fixtureDocuments = null,
}) {
  const safe = safeResearchUrl(domain);
  if (!safe.ok) return { status: "blocked", error: safe.error, retryable: false, pages: [], signals: [] };
  if (safe.hostname.endsWith(".example") || safe.hostname.endsWith(".invalid")) {
    if (!fixtureDocuments) return { status: "blocked", error: "reserved-domain", retryable: false, pages: [], signals: [] };
  }

  const pages = [];
  const failures = [];
  const first = await fetchDocument(safe.url.href, safe.hostname, {
    fetchImpl, timeoutMs, maxBytes, fixtureDocuments,
  });
  if (!first.ok) {
    return { status: first.blocked ? "blocked" : "failed", error: first.error,
      retryable: first.retryable, pages: [], signals: [], failures: [first] };
  }
  pages.push(await pageObservation(first, safe.hostname));

  const additional = selectResearchLinks(pages[0].analysis.internal_links, safe.hostname, maxPages - 1);
  for (const url of additional) {
    const result = await fetchDocument(url, safe.hostname, { fetchImpl, timeoutMs, maxBytes, fixtureDocuments });
    if (result.ok) pages.push(await pageObservation(result, safe.hostname));
    else failures.push(result);
  }

  const jobPages = [];
  const jobLinks = uniqueBy(pages.flatMap((page) => page.analysis.public_job_links || []), (value) => value).slice(0, 2);
  for (const url of jobLinks) {
    const safeJob = safeResearchUrl(url);
    if (!safeJob.ok || !PUBLIC_JOB_HOSTS.has(safeJob.hostname)) continue;
    const result = await fetchDocument(url, safeJob.hostname, { fetchImpl, timeoutMs, maxBytes, fixtureDocuments: null });
    if (result.ok) jobPages.push(await pageObservation(result));
    else failures.push(result);
  }

  const signals = detectOpportunitySignals(pages, new Date().getUTCFullYear(), jobPages);
  const capacitySignals = detectCapacitySignals(pages, jobPages);
  const facts = evidenceFacts(pages);
  const decisionMakers = uniqueBy(pages.flatMap((page) => page.analysis.decision_makers),
    (item) => `${item.name.toLowerCase()}|${item.title.toLowerCase()}`);
  const contactPaths = uniqueBy(pages.flatMap((page) => page.analysis.contacts),
    (item) => `${item.type}|${item.value.toLowerCase()}`);
  return {
    status: "fetched",
    source_url: pages[0].source_url,
    final_url: pages[0].final_url,
    pages,
    job_pages: jobPages,
    signals,
    capacity_signals: capacitySignals,
    facts,
    decision_makers: decisionMakers,
    contact_paths: contactPaths,
    has_contact_page: pages.some((page) => page.analysis.has_contact_page),
    failures,
    retryable: false,
  };
}

async function fetchDocument(input, expectedHost, { fetchImpl, timeoutMs, maxBytes, fixtureDocuments }) {
  const safe = safeResearchUrl(input);
  if (!safe.ok || !sameSite(safe.hostname, expectedHost)) {
    return { ok: false, blocked: true, retryable: false, error: "off-domain-url", source_url: input };
  }
  if (fixtureDocuments && Object.prototype.hasOwnProperty.call(fixtureDocuments, safe.url.href)) {
    return { ok: true, source_url: safe.url.href, final_url: safe.url.href, status: 200,
      content_type: "text/html", html: String(fixtureDocuments[safe.url.href]) };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, retryable: true, error: "fetch-unavailable", source_url: safe.url.href };
  }
  let current = safe.url;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Reachwright/0.4 evidence research" },
      });
    } catch (cause) {
      clearTimeout(timer);
      return { ok: false, retryable: true,
        error: cause?.name === "AbortError" ? "website-timeout" : "website-network", source_url: safe.url.href };
    }
    clearTimeout(timer);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, retryable: false, error: "redirect-without-location", source_url: safe.url.href };
      const next = safeResearchUrl(new URL(location, current).href);
      if (!next.ok || !sameSite(next.hostname, expectedHost)) {
        return { ok: false, blocked: true, retryable: false, error: "off-domain-redirect", source_url: safe.url.href };
      }
      current = next.url;
      continue;
    }
    if (!response.ok) return { ok: false, retryable: response.status === 429 || response.status >= 500,
      error: `website-http-${response.status}`, http_status: response.status, source_url: safe.url.href };
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) return { ok: false, blocked: true, retryable: false,
      error: "website-too-large", source_url: safe.url.href };
    const html = await response.text();
    const size = new TextEncoder().encode(html).byteLength;
    if (size > maxBytes) return { ok: false, blocked: true, retryable: false,
      error: "website-too-large", source_url: safe.url.href };
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { ok: false, blocked: true, retryable: false, error: "website-not-html", source_url: safe.url.href };
    }
    return { ok: true, source_url: safe.url.href, final_url: current.href, status: response.status,
      content_type: contentType || "text/html", html };
  }
  return { ok: false, blocked: true, retryable: false, error: "too-many-redirects", source_url: safe.url.href };
}

async function pageObservation(result) {
  const analysis = analyzeHtml(result.html, result.final_url);
  return {
    source_url: result.source_url,
    final_url: result.final_url,
    http_status: result.status,
    content_hash: await sha256(result.html),
    analysis,
  };
}

export function detectOpportunitySignals(pages, nowYear = new Date().getUTCFullYear(), supplementalPages = []) {
  if (!pages?.length) return [];
  const home = pages[0];
  const a = home.analysis;
  const signals = [];
  const add = (type, claim, confidence, source = home.final_url, details = {}) => signals.push({
    type, claim, confidence, source_url: source, dimension: "copy-opportunity", ...details,
  });
  if (!a.has_viewport) add("missing-mobile-viewport",
    "The homepage HTML reviewed does not contain a viewport meta tag.", 90);
  if (!a.title) add("missing-page-title", "The homepage reviewed does not provide a non-empty HTML page title.", 95);
  if (!a.meta_description) add("missing-meta-description",
    "The homepage reviewed does not provide a meta description.", 90);
  if (!a.primary_heading) add("missing-primary-heading",
    "The homepage reviewed does not contain a detectable H1 heading.", 85);
  if (!a.has_primary_cta) add("missing-primary-cta",
    "The homepage reviewed does not contain a detected contact, quote, booking, consultation, purchase, or get-started call to action.", 78);
  if (!pages.some((page) => page.analysis.has_form)) add("missing-form",
    `No HTML form was detected across the ${pages.length} official page${pages.length === 1 ? "" : "s"} reviewed.`, 82);
  if (!pages.some((page) => page.analysis.has_booking_path)) add("missing-booking-path",
    `No booking or scheduling path was detected across the ${pages.length} official page${pages.length === 1 ? "" : "s"} reviewed.`, 72);
  const hasLeadCapturePath = pages.some((page) => page.analysis.has_form
    || page.analysis.has_booking_path
    || page.analysis.has_phone_path
    || page.analysis.has_email_path
    || page.analysis.has_contact_page);
  if (!hasLeadCapturePath) add("missing-lead-capture",
    `No form, booking path, phone link, email link, or contact page was detected across the ${pages.length} official page${pages.length === 1 ? "" : "s"} reviewed.`, 92);
  const hasDirect = pages.some((page) => page.analysis.has_phone_path || page.analysis.has_email_path);
  const hasConversion = pages.some((page) => page.analysis.has_form || page.analysis.has_booking_path);
  if (hasDirect && !hasConversion) add("manual-only-contact",
    "The reviewed pages expose a direct phone or email path, but no form or booking path was detected.", 76);
  if (a.copyright_year && a.copyright_year <= nowYear - 3) add("stale-copyright",
    `The homepage displays a latest detected copyright year of ${a.copyright_year}.`, 70);
  const copyHiring = [...pages, ...supplementalPages].find((page) =>
    (/\b(?:careers?|jobs?|join-us|work-with-us)\b/i.test(page.final_url) || publicJobBoardUrl(page.final_url))
    && page.analysis.copy_role_mentions?.length);
  const role = copyHiring?.analysis.copy_role_mentions?.[0];
  if (copyHiring) add("hiring-copy-content-roles",
    `The current careers page lists “${role.title}”.`,
    90, role.url || copyHiring.final_url, {
      role_title: role.title,
      ...(publicJobBoardUrl(copyHiring.final_url)
        ? { source_type: "authoritative-directory", strength: "authoritative-directory" } : {}),
    });
  return uniqueBy(signals, (item) => item.type);
}

/**
 * Public capacity evidence is deliberately narrow. A live conversion flow is
 * observable acquisition investment; it is not proof of budget, revenue,
 * urgency, or dissatisfaction with the prospect's current copy.
 */
export function detectCapacitySignals(pages, supplementalPages = []) {
  if (!pages?.length) return [];
  const signals = [];
  const page = pages.find((item) => item.analysis.has_form || item.analysis.has_booking_path
    || item.analysis.has_chat_path);
  if (page) {
    const features = [page.analysis.has_form ? "a form" : "",
      page.analysis.has_booking_path ? "a booking path" : "",
      page.analysis.has_chat_path ? "a live-chat path" : ""].filter(Boolean);
    signals.push({
      type: "lead-gen-infrastructure-active", dimension: "buying-trigger",
      claim: `The official page reviewed contains ${features.join(" and ")}, showing active public lead-generation infrastructure.`,
      confidence: 78, source_url: page.final_url,
    });
  }
  const copyHiring = [...pages, ...supplementalPages].find((item) =>
    (/\b(?:careers?|jobs?|join-us|work-with-us)\b/i.test(item.final_url) || publicJobBoardUrl(item.final_url))
    && item.analysis.copy_role_mentions?.length);
  const role = copyHiring?.analysis.copy_role_mentions?.[0];
  if (copyHiring) signals.push({
    type: "hiring-current", dimension: "buying-trigger",
    claim: `The current careers page lists “${role.title}”.`,
    confidence: 90, source_url: role.url || copyHiring.final_url,
    role_title: role.title,
    ...(publicJobBoardUrl(copyHiring.final_url)
      ? { source_type: "authoritative-directory", strength: "authoritative-directory" } : {}),
  });
  return uniqueBy(signals, (item) => item.type);
}

function evidenceFacts(pages) {
  const facts = [];
  for (const page of pages) {
    const a = page.analysis;
    if (a.title) facts.push({ claim: `The official page title is “${a.title}”.`, source_url: page.final_url, confidence: 95 });
    if (a.primary_heading) facts.push({ claim: `The official page primary heading is “${a.primary_heading}”.`, source_url: page.final_url, confidence: 95 });
    if (a.meta_description) facts.push({ claim: `The official page describes the business as “${a.meta_description}”.`, source_url: page.final_url, confidence: 90 });
  }
  return uniqueBy(facts, (item) => `${item.claim}|${item.source_url}`).slice(0, 8);
}

function selectResearchLinks(links, hostname, limit) {
  const candidates = uniqueBy(links.filter((link) => {
    try { return sameSite(new URL(link.href).hostname, hostname); } catch { return false; }
  }).map((link) => {
    const category = researchLinkCategory(link);
    return { ...link, category, rank: researchLinkRank(link, category) };
  }).filter((link) => link.category),
  (item) => new URL(item.href).href.replace(/\/$/, ""));

  const selected = [];
  for (const category of RESEARCH_CATEGORY_ORDER) {
    const best = candidates.filter((item) => item.category === category)
      .sort((a, b) => a.rank - b.rank || a.href.localeCompare(b.href))[0];
    if (best) selected.push(best);
  }

  if (selected.length < limit) {
    const selectedUrls = new Set(selected.map((item) => new URL(item.href).href.replace(/\/$/, "")));
    const remaining = candidates.filter((item) => !selectedUrls.has(new URL(item.href).href.replace(/\/$/, "")))
      .sort((a, b) => RESEARCH_CATEGORY_ORDER.indexOf(a.category) - RESEARCH_CATEGORY_ORDER.indexOf(b.category)
        || a.rank - b.rank || a.href.localeCompare(b.href));
    selected.push(...remaining);
  }
  return selected.slice(0, Math.max(0, limit)).map((item) => item.href);
}

function researchLinkCategory(link) {
  const value = `${link.text} ${link.href}`.toLowerCase();
  if (/contact|get-in-touch|reach-us/.test(value)) return "contact";
  if (/about|team|leadership|people|management|company|who-we-are|our-story/.test(value)) return "people";
  if (/careers?|jobs?|join-us|work-with-us|open-positions/.test(value)) return "careers";
  if (/services|solutions|capabilities|what-we-do|our-work/.test(value)) return "services";
  return "";
}

function researchLinkRank(link, category) {
  const value = `${link.text} ${link.href}`.toLowerCase();
  if (category === "contact") return /contact(?:-us)?/.test(value) ? 0 : 1;
  if (category === "people") return /leadership|team|people|management/.test(value) ? 0 : 1;
  if (category === "services") return /services|solutions|capabilities|what-we-do/.test(value) ? 0 : 1;
  return 9;
}

function extractLinks(html, sourceUrl) {
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig)) {
    const raw = decodeEntities(match[1]).trim();
    const text = cleanText(match[2]).slice(0, 200);
    if (!raw || raw.startsWith("#") || /^(javascript|data):/i.test(raw)) continue;
    if (/^(mailto|tel):/i.test(raw)) links.push({ href: raw, text });
    else {
      try { links.push({ href: new URL(raw, sourceUrl).href, text }); } catch { /* malformed link */ }
    }
  }
  return links.slice(0, 300);
}

/**
 * A careers page is not a hiring signal merely because its global navigation
 * mentions "email marketing" or "content marketing". Require a role-shaped
 * phrase in a short job-like element, or an explicit hiring sentence. This
 * keeps service links and product navigation out of the opportunity feed.
 */
function extractCopyRoleMentions(html, sourceUrl) {
  const sourceIsCareers = /\b(?:careers?|jobs?|join-us|work-with-us)\b/i.test(sourceUrl)
    || publicJobBoardUrl(sourceUrl);
  const mentions = [];
  const add = (text, url = sourceUrl, { explicitContext = false, allowCareersPage = true } = {}) => {
    const cleaned = cleanText(text).replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.length > 220) return;
    const match = cleaned.match(COPY_ROLE_WORDS);
    if (!match) return;
    if (!explicitContext && !COPY_ROLE_CONTEXT.test(cleaned) && !(sourceIsCareers && allowCareersPage)) return;
    const title = match[0].replace(/\b\w/g, (letter) => letter.toUpperCase())
      .replace(/\bSeo\b/g, "SEO").replace(/\bAeo\b/g, "AEO");
    mentions.push({ title, url });
  };

  for (const match of String(html).matchAll(/<(h[1-6]|li|p)\b[^>]*>([\s\S]*?)<\/\1>/ig)) {
    const cleaned = cleanText(match[2]);
    const shortRoleElement = cleaned.length <= 120;
    add(cleaned, sourceUrl, { explicitContext: COPY_ROLE_CONTEXT.test(cleaned) || (sourceIsCareers && shortRoleElement) });
  }
  for (const link of extractLinks(html, sourceUrl)) {
    if (!COPY_ROLE_WORDS.test(link.text || "")) continue;
    let jobLikeUrl = false;
    try {
      const url = new URL(link.href);
      jobLikeUrl = publicJobBoardUrl(url.href)
        || /\b(?:careers?|jobs?|apply|openings?|positions?)\b/i.test(url.pathname + url.hostname);
    } catch { /* malformed links were already excluded by extractLinks */ }
    add(link.text, link.href, {
      explicitContext: jobLikeUrl || COPY_ROLE_CONTEXT.test(link.text || ""),
      allowCareersPage: false,
    });
  }
  return uniqueBy(mentions, (item) => `${item.title.toLowerCase()}|${item.url}`).slice(0, 5);
}

function extractContactPaths(links, sourceUrl) {
  const paths = [];
  for (const link of links) {
    if (link.href.startsWith("mailto:")) {
      const value = link.href.slice(7).split("?")[0].trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) paths.push({ type: "email", value, source_url: sourceUrl });
    } else if (link.href.startsWith("tel:")) {
      const value = link.href.slice(4).split("?")[0].trim();
      if (value.replace(/\D/g, "").length >= 7) paths.push({ type: "phone", value, source_url: sourceUrl });
    } else {
      let url;
      try { url = new URL(link.href); } catch { continue; }
      if (/linkedin\.com$/i.test(url.hostname.replace(/^www\./, "")) && /^\/in\//i.test(url.pathname)) {
        paths.push({ type: "linkedin", value: url.href, source_url: sourceUrl, label: link.text });
      } else if (isContactPageUrl(url.href)) {
        paths.push({ type: "contact-page", value: url.href, source_url: sourceUrl });
      }
    }
  }
  return paths;
}

function extractDecisionMakers(html, visibleText, links, sourceUrl) {
  const people = [];
  for (const script of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig)) {
    try { collectStructuredPeople(JSON.parse(script[1]), people, sourceUrl); } catch { /* malformed JSON-LD */ }
  }
  const lines = visibleText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const name = "([A-Z][A-Za-z'.-]+(?:\\s+[A-Z][A-Za-z'.-]+){1,3})";
  const title = "(Owner|Co[- ]?Founder|Founder|Chief Executive(?: Officer)?|CEO|President|Principal|Managing Partner|Managing Director|General Manager|Partner)";
  const forward = new RegExp(`${name}\\s*(?:[-–—|,]|is\\s+(?:the\\s+)?)\\s*${title}`, "i");
  const reverse = new RegExp(`${title}\\s*(?:[-–—|,:]|is)\\s*${name}`, "i");
  for (const line of lines.slice(0, 500)) {
    let match = line.match(forward);
    if (match) people.push({ name: cleanText(match[1]), title: cleanText(match[2]), source_url: sourceUrl });
    else {
      match = line.match(reverse);
      if (match) people.push({ name: cleanText(match[2]), title: cleanText(match[1]), source_url: sourceUrl });
    }
  }
  for (const person of people) {
    const profile = links.find((link) => /linkedin\.com\/in\//i.test(link.href)
      && link.text && person.name.toLowerCase().split(/\s+/).some((part) => part.length > 2 && link.text.toLowerCase().includes(part)));
    if (profile) person.public_profile_url = profile.href;
  }
  return uniqueBy(people.filter((person) => plausibleName(person.name) && EXECUTIVE_TITLE.test(person.title)),
    (person) => `${person.name.toLowerCase()}|${person.title.toLowerCase()}`);
}

function collectStructuredPeople(value, output, sourceUrl) {
  if (Array.isArray(value)) return value.forEach((item) => collectStructuredPeople(item, output, sourceUrl));
  if (!value || typeof value !== "object") return;
  const name = typeof value.name === "string" ? cleanText(value.name) : "";
  const title = typeof value.jobTitle === "string" ? cleanText(value.jobTitle) : "";
  if (plausibleName(name) && EXECUTIVE_TITLE.test(title)) {
    const sameAs = Array.isArray(value.sameAs) ? value.sameAs : [value.sameAs];
    const linkedin = sameAs.find((item) => typeof item === "string" && /linkedin\.com\/in\//i.test(item));
    output.push({ name, title, source_url: sourceUrl, ...(linkedin ? { public_profile_url: linkedin } : {}) });
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") collectStructuredPeople(nested, output, sourceUrl);
  }
}

function plausibleName(value) {
  const parts = String(value || "").trim().split(/\s+/);
  return parts.length >= 2 && parts.length <= 4 && parts.every((part) => /^[A-Za-z][A-Za-z'.-]+$/.test(part));
}

function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<\/(?:p|div|li|section|article|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
}

function cleanText(value) {
  return htmlToText(String(value || "")).replace(/\s+/g, " ").trim();
}

function firstMatch(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(?:x([0-9a-f]{1,8})|([0-9]{1,10}));/gi, (entity, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10FFFF
        || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return entity;
      return String.fromCodePoint(codePoint);
    })
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function isContactPageUrl(value) {
  try { return CONTACT_PAGE_PATH.test(new URL(value).pathname); } catch { return false; }
}

function isSameSiteContactPageLink(link, sourceUrl) {
  if (!/^https?:/i.test(link.href) || !isContactPageUrl(link.href)) return false;
  try { return sameSite(new URL(link.href).hostname, new URL(sourceUrl).hostname); } catch { return false; }
}

function publicJobBoardUrl(value) {
  try { return PUBLIC_JOB_HOSTS.has(new URL(value).hostname.toLowerCase()); }
  catch { return false; }
}

function sameSite(hostname, expected) {
  const host = String(hostname || "").toLowerCase().replace(/^www\./, "");
  const root = String(expected || "").toLowerCase().replace(/^www\./, "");
  return host === root || host.endsWith(`.${root}`) || root.endsWith(`.${host}`);
}

function unsafeHostname(hostname) {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.includes(":")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const parts = hostname.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] >= 224
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  return false;
}

function uniqueBy(items, key) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value); return true;
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
