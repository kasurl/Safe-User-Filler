// ==UserScript==
// @name         Safe User Filler
// @namespace    local.safe-user-filler
// @version      1.5.1
// @description  Safe User Filler JSON + CSV survey filler. Auto-fills, auto-pages, and can chain after manual submit; never auto-submits.
// @match        *://*/*
// @include      *://*.wjx.cn/*
// @include      *://*.wjx.com/*
// @include      *://wj.qq.com/*
// @include      *://*.wj.qq.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG_KEY = "safe_user_filler_config_v1";
  const QUEUE_KEY = "safe_user_filler_queue_v1";
  const INDEX_KEY = "safe_user_filler_index_v1";
  const ADVANCE_KEY = "safe_user_filler_advance_after_submit_v1";
  const AUTO_CHAIN_KEY = "safe_user_filler_auto_chain_v1";
  const PAGE_CACHE_KEY = "safe_user_filler_page_cache_v1";
  const WINDOW_PENDING_PREFIX = "safe_user_filler_pending:";

  const defaultConfig = {
    surveyUrl: "",
    name: "Safe User Filler",
    submitManualOnly: true,
    maxPages: 150,
    returnAfterManualSubmitMs: 1500,
    navigation: {
      nextText: ["下一页", "下一步", "继续", "Next"],
      submitText: ["提交", "完成", "Submit"]
    },
    questions: [
      {
        key: "Q1",
        title: "题目标题",
        type: "radio",
        options: ["选项A", "选项B"],
        answerMode: "index",
        aliases: {}
      }
    ]
  };

  let config = loadJson(CONFIG_KEY, defaultConfig);
  let queue = loadJson(QUEUE_KEY, []);
  let currentIndex = Number(localStorage.getItem(INDEX_KEY) || 0);
  let panelClosed = false;
  let submitGuardInstalled = false;
  let lifecycleSubmitWatcherInstalled = false;
  if (!Number.isFinite(currentIndex) || currentIndex < 0) currentIndex = 0;

  function loadJson(key, fallback) {
    try {
      const saved = localStorage.getItem(key);
      return saved ? JSON.parse(saved) : fallback;
    } catch (error) {
      console.warn("[SafeUserFiller] Failed to load", key, error);
      return fallback;
    }
  }

  function saveState() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    localStorage.setItem(INDEX_KEY, String(currentIndex));
  }

  function normalizeConfig(rawConfig) {
    const nextConfig = Object.assign({}, defaultConfig, rawConfig || {});
    nextConfig.navigation = Object.assign({}, defaultConfig.navigation, rawConfig?.navigation || {});
    nextConfig.questions = Array.isArray(rawConfig?.questions) ? rawConfig.questions : defaultConfig.questions;
    nextConfig.maxPages = Number(rawConfig?.maxPages || defaultConfig.maxPages);
    nextConfig.returnAfterManualSubmitMs = Number(rawConfig?.returnAfterManualSubmitMs || defaultConfig.returnAfterManualSubmitMs);
    return nextConfig;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeForMatch(value) {
    return normalizeText(value)
      .replace(/\{fillblank-[^}]+\}/g, "")
      .replace(/____+/g, "")
      .replace(/[“”"'\s（）()，,。？?、：:；;\/\\-]/g, "")
      .toLowerCase();
  }

  function visibleText(element) {
    return normalizeText(element.innerText || element.textContent || element.value || "");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function isDisabled(element) {
    return Boolean(
      element.disabled
      || element.getAttribute?.("disabled") !== null
      || element.getAttribute?.("aria-disabled") === "true"
      || /\b(disabled|is-disabled)\b/i.test(String(element.className || ""))
    );
  }

  function getCurrentItem() {
    return queue[currentIndex] || null;
  }

  function getAllQuestions() {
    const byKey = new Map();
    for (const question of config.questions || []) {
      if (question && question.key) byKey.set(question.key, question);
    }
    return Array.from(byKey.values());
  }

  function getQuestionsForPage(pageNumber) {
    const cached = getCachedQuestionsForPage(pageNumber);
    if (cached.length) return cached;
    return discoverQuestionsOnCurrentPage();
  }

  function getCacheScope() {
    return normalizeForMatch(config.surveyUrl || location.origin + location.pathname || "default");
  }

  function loadPageCache() {
    return loadJson(PAGE_CACHE_KEY, {});
  }

  function savePageCache(cache) {
    localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(cache));
  }

  function getCachedQuestionsForPage(pageNumber) {
    const scoped = loadPageCache()[getCacheScope()] || {};
    const keys = scoped[String(pageNumber)] || [];
    if (!keys.length) return [];
    const questionsByKey = new Map(getAllQuestions().map((question) => [question.key, question]));
    return keys.map((key) => questionsByKey.get(key)).filter(Boolean);
  }

  function cacheQuestionsForPage(pageNumber, questions) {
    if (!questions.length) return;
    const cache = loadPageCache();
    const scope = getCacheScope();
    cache[scope] = cache[scope] || {};
    cache[scope][String(pageNumber)] = questions.map((question) => question.key).filter(Boolean);
    savePageCache(cache);
  }

  function clearPageCache() {
    const cache = loadPageCache();
    delete cache[getCacheScope()];
    savePageCache(cache);
    updateStatus("当前问卷的分页缓存已清除。");
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function actionPattern(words) {
    const source = (words || []).map(escapeRegExp).join("|") || "$a";
    return new RegExp(`^(${source})$`, "i");
  }

  function pageSignature() {
    return normalizeText(document.body.innerText).slice(0, 2000);
  }

  function inferCurrentPageNumber() {
    const body = normalizeForMatch(document.body.innerText || "");
    const scoped = loadPageCache()[getCacheScope()] || {};
    const scored = Object.entries(scoped).map(([page, keys]) => {
      const questionsByKey = new Map(getAllQuestions().map((question) => [question.key, question]));
      const score = (keys || []).reduce((total, key) => {
        const question = questionsByKey.get(key);
        return total + (question.title && body.includes(normalizeForMatch(question.title)) ? 1 : 0);
      }, 0);
      return { page: Number(page), score };
    }).sort((a, b) => b.score - a.score);
    return scored[0] && scored[0].score > 0 ? scored[0].page : 1;
  }

  function findActionButton(words) {
    const pattern = actionPattern(words);
    const selector = "button, input[type='button'], input[type='submit'], [role='button'], a, #ctlNext, .submitbtn";
    const candidates = Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .filter((element) => !isDisabled(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, text: visibleText(element), area: rect.width * rect.height };
      })
      .filter((item) => pattern.test(item.text));
    candidates.sort((a, b) => a.text.length - b.text.length || a.area - b.area);
    return candidates[0] ? candidates[0].element : null;
  }

  function isNavigationLike(element) {
    const text = visibleText(element);
    const words = [
      ...(config.navigation?.nextText || []),
      ...(config.navigation?.submitText || []),
      "上一页", "上一步", "返回", "取消", "确定"
    ];
    return actionPattern(words).test(text);
  }

  function questionBlockCandidates() {
    const inputSelector = "input, textarea, select, [role='radio'], [role='checkbox'], [contenteditable='true'], [contenteditable='plaintext-only']";
    const candidates = Array.from(document.querySelectorAll("div, section, li, article, form"))
      .filter(isVisible)
      .filter((element) => visibleText(element).length > 0)
      .filter((element) => element.querySelectorAll(inputSelector).length > 0);
    return candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });
  }

  function findQuestionBlock(question, fallbackBlock) {
    const title = normalizeForMatch(question.title || question.key);
    const candidates = questionBlockCandidates().filter((element) => {
      const text = normalizeForMatch(visibleText(element));
      return text.includes(title);
    });
    if (candidates[0]) return candidates[0];
    return fallbackBlock || null;
  }

  function discoverQuestionsOnCurrentPage() {
    const blocks = questionBlockCandidates();
    const discovered = [];
    for (const question of getAllQuestions()) {
      const block = findQuestionBlock(question, null);
      if (block && blocks.includes(block) && !discovered.some((item) => item.key === question.key)) {
        discovered.push(question);
      }
    }
    return discovered;
  }

  function resolveAnswerText(question, value) {
    const text = normalizeText(value);
    const aliases = question.aliases || {};
    if (aliases[text]) return aliases[text];
    const compact = normalizeForMatch(text);
    const aliasEntry = Object.entries(aliases).find(([alias]) => normalizeForMatch(alias) === compact);
    if (aliasEntry) return aliasEntry[1];
    const option = (question.options || []).find((item) => normalizeForMatch(item) === compact)
      || (question.options || []).find((item) => {
        const optionText = normalizeForMatch(item);
        return optionText && (optionText.includes(compact) || compact.includes(optionText));
      });
    return option || text;
  }

  function optionIsSelected(element) {
    const input = element.matches?.("input")
      ? element
      : element.querySelector?.("input")
        || element.closest?.(".ui-radio,.ui-checkbox")?.querySelector?.("input[type='radio'], input[type='checkbox']");
    if (input && ["radio", "checkbox"].includes(input.type)) return input.checked;
    if (element.getAttribute?.("aria-checked") === "true") return true;
    return /\b(selected|checked|active|is-checked)\b/i.test(String(element.className || ""));
  }

  function clickableFromTextElement(element) {
    const wjxInput = resolveWjxInput(element);
    if (wjxInput) {
      const wjxWrapper = wjxInput.closest(".ui-radio,.ui-checkbox");
      const wjxClickable = wjxWrapper?.querySelector?.("a.jqradio, a.jqcheck") || wjxWrapper?.querySelector?.(".label");
      if (wjxClickable && !isNavigationLike(wjxClickable)) return wjxClickable;
    }

    const label = element.closest("label");
    if (label && !isNavigationLike(label)) return label;
    const role = element.closest("[role='radio'], [role='checkbox']");
    if (role && !isNavigationLike(role)) return role;
    const input = element.querySelector?.("input[type='radio'], input[type='checkbox']")
      || element.parentElement?.querySelector?.("input[type='radio'], input[type='checkbox']");
    if (input && !isNavigationLike(input)) return input;
    const button = element.closest("button");
    if (button && !isNavigationLike(button)) return button;
    return !isNavigationLike(element) ? element : null;
  }

  function resolveWjxInput(element) {
    const forId = element.getAttribute?.("for");
    if (forId) {
      const input = document.getElementById(forId);
      if (input && ["radio", "checkbox"].includes(input.type)) return input;
    }
    const wrapperInput = element.closest?.(".ui-radio,.ui-checkbox")?.querySelector?.("input[type='radio'], input[type='checkbox']");
    if (wrapperInput) return wrapperInput;
    const parentInput = element.parentElement?.querySelector?.("input[type='radio'], input[type='checkbox']");
    return parentInput || null;
  }

  function findOptionElement(block, answerText, question) {
    if (question.answerMode === "index") {
      const indexOption = findOptionElementByIndex(block, answerText);
      if (indexOption) return indexOption;
    }

    const wanted = normalizeText(resolveAnswerText(question, answerText));
    const compactWanted = normalizeForMatch(wanted);
    const selector = "label, button, [role='radio'], [role='checkbox'], input[type='radio'], input[type='checkbox'], span, p, li, div";
    const matches = Array.from(block.querySelectorAll(selector))
      .filter(isVisible)
      .filter((element) => !isNavigationLike(element))
      .map((element) => {
        const text = normalizeText(element.matches("input") ? element.value : visibleText(element));
        const compact = normalizeForMatch(text);
        let score = -1;
        if (text === wanted || compact === compactWanted) score = 1000;
        else if (compact && compact.includes(compactWanted)) score = 700;
        else if (compact && compactWanted.includes(compact) && compact.length >= 2) score = 450;
        if (score < 0) return null;
        if (text.length > wanted.length + 35) score -= 250;
        if (element.matches("label, button, [role='radio'], [role='checkbox'], input")) score += 80;
        const rect = element.getBoundingClientRect();
        return { element, score, text, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.area - b.area);
    const match = matches.find((item) => clickableFromTextElement(item.element));
    if (match) return clickableFromTextElement(match.element);
    return findOptionElementByIndex(block, answerText);
  }

  function parseOptionIndex(value) {
    const text = normalizeText(value);
    const match = text.match(/^(?:#|第)?\s*(\d{1,3})\s*(?:个|项|选项)?$/);
    if (!match) return null;
    const index = Number(match[1]);
    return Number.isInteger(index) && index > 0 ? index : null;
  }

  function getChoiceCandidates(block) {
    const seen = new Set();
    const candidates = [];
    const push = (element) => {
      const clickable = clickableFromTextElement(element);
      if (!clickable || !isVisible(clickable) || isNavigationLike(clickable)) return;
      const input = resolveWjxInput(clickable)
        || clickable.matches?.("input[type='radio'], input[type='checkbox']") && clickable
        || clickable.querySelector?.("input[type='radio'], input[type='checkbox']");
      const key = input?.id || input?.name && `${input.name}:${input.value}` || `${clickable.tagName}:${visibleText(clickable)}:${Math.round(clickable.getBoundingClientRect().top)}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(clickable);
    };

    block.querySelectorAll(".ui-radio, .ui-checkbox").forEach(push);
    block.querySelectorAll("label, [role='radio'], [role='checkbox'], input[type='radio'], input[type='checkbox']").forEach(push);
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || ar.left - br.left;
    });
    return candidates;
  }

  function findOptionElementByIndex(block, answerText) {
    const index = parseOptionIndex(answerText);
    if (!index) return null;
    const choices = getChoiceCandidates(block);
    return choices[index - 1] || null;
  }

  function clickOption(block, answerText, question) {
    const option = findOptionElement(block, answerText, question);
    if (!option) return false;
    option.scrollIntoView({ block: "center", inline: "nearest" });
    const before = optionIsSelected(option);
    option.click();
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    option.dispatchEvent(new Event("change", { bubbles: true }));
    const after = optionIsSelected(option);
    return before || after || !option.matches?.("input[type='radio'], input[type='checkbox']");
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function dispatchTextEvents(element, value) {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Process" }));
    if (typeof InputEvent === "function") {
      try {
        element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: value }));
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      } catch (error) {
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function fillText(block, value) {
    const text = String(value);
    const input = Array.from(block.querySelectorAll("textarea, input[type='text'], input[type='number'], input[type='search'], input:not([type])"))
      .find(isVisible);
    const editable = Array.from(block.querySelectorAll("[contenteditable='true'], [contenteditable='plaintext-only']")).find(isVisible);
    if (!input && !editable) return false;
    const target = input || editable;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.focus();
    if (editable) {
      editable.textContent = text;
      dispatchTextEvents(editable, text);
      editable.blur();
      return normalizeText(editable.innerText || editable.textContent).includes(normalizeText(text));
    }
    target.select?.();
    setNativeValue(target, "");
    dispatchTextEvents(target, "");
    setNativeValue(target, text);
    dispatchTextEvents(target, text);
    target.blur();
    return normalizeText(target.value) === normalizeText(text);
  }

  function fillSelect(block, value, question) {
    const select = Array.from(block.querySelectorAll("select")).find(isVisible);
    if (!select) return false;
    const index = parseOptionIndex(value);
    if (question.answerMode === "index" && index && select.options[index - 1]) {
      select.value = select.options[index - 1].value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    const wanted = normalizeForMatch(resolveAnswerText(question, value));
    const option = Array.from(select.options).find((item) => {
      const text = normalizeForMatch(item.textContent);
      return text === wanted || text.includes(wanted) || wanted.includes(text);
    }) || (index && select.options[index - 1]);
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function getAnswerValue(row, question) {
    if (!row || !question) return undefined;
    const keys = [question.key, question.title, `Q${question.no || ""}`].filter(Boolean);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row.answers || row, key)) return (row.answers || row)[key];
    }
    return undefined;
  }

  async function fillPage(pageNumber = inferCurrentPageNumber()) {
    const item = getCurrentItem();
    if (!item) throw new Error("当前没有 CSV 队列数据。");
    const questions = getQuestionsForPage(pageNumber);
    if (!questions.length) throw new Error(`第 ${pageNumber} 页没有识别到题目。请检查 JSON 的 questions 是否覆盖当前页题目标题。`);
    cacheQuestionsForPage(pageNumber, questions);
    const blocks = questionBlockCandidates();
    const warnings = [];
    const empty = [];
    let filledCount = 0;

    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const value = getAnswerValue(item, question);
      const values = Array.isArray(value) ? value : splitMultiValue(value, question);
      if (!values.length) {
        empty.push(question.key);
        continue;
      }

      const block = findQuestionBlock(question, blocks[index]);
      if (!block) {
        warnings.push(`${question.key} 未在当前页找到`);
        continue;
      }

      let touched = false;
      for (const answer of values) {
        const ok = clickOption(block, answer, question) || fillSelect(block, answer, question) || fillText(block, answer);
        if (!ok) warnings.push(`${question.key} 没有匹配到答案：${answer}`);
        else touched = true;
        await sleep(140);
      }
      if (touched) filledCount += 1;
    }

    if (warnings.length) updateStatus(warnings.join("；"));
    else updateStatus(`已填第 ${pageNumber} 页：${filledCount} 题${empty.length ? `；空值：${empty.join("、")}` : ""}`);
    return { filledCount, warnings, empty, pageNumber };
  }

  function splitMultiValue(value, question) {
    if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
    const text = normalizeText(value);
    if (!text) return [];
    if (question.type === "checkbox") return text.split(/\s*[|；;]\s*/g).map(normalizeText).filter(Boolean);
    return [text];
  }

  async function waitForPageChange(previousSignature, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(250);
      if (pageSignature() !== previousSignature) {
        await sleep(700);
        return true;
      }
    }
    return false;
  }

  async function fillAllPages() {
    const maxPages = Math.max(1, Number(config.maxPages || 30));
    const touched = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await fillPage(page);
      touched.push(result.filledCount);
      if (result.warnings.length) return { done: false, reason: "warning", filledPages: touched, warnings: result.warnings };
      await sleep(400);
      const next = findActionButton(config.navigation?.nextText || []);
      if (!next) {
        const submit = findActionButton(config.navigation?.submitText || []);

       if (submit) {
  highlightElement(submit);
  updateStatus("已到最后一页，正在模拟点击提交按钮，2 秒后自动返回问卷。");

  const returnUrl = getSurveyReturnUrl();

  markAdvanceAfterManualSubmit();

  await sleep(300);
  submit.click();

  scheduleReturnToSurvey(returnUrl, 2000);

  return {
    done: true,
    reason: "clicked-submit-button-from-fill-all",
    filledPages: touched
  };
}

        updateStatus("已到最后一页，但没有找到提交按钮，请检查提交按钮文字配置。");

        return {
          done: false,
          reason: "no-next-and-no-submit",
          filledPages: touched
        };
      }
      const before = pageSignature();
      next.scrollIntoView({ block: "center", inline: "nearest" });
      next.click();
      const changed = await waitForPageChange(before);
      if (!changed) return { done: false, reason: "no-page-change", filledPages: touched };
    }
    updateStatus(`连续填入已暂停：超过安全页数上限 ${maxPages}，请检查页面状态。`);
    return { done: false, reason: "max-pages", filledPages: touched };
  }

  function highlightElement(element) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.style.outline = "4px solid #f59e0b";
    element.style.outlineOffset = "4px";
    element.style.boxShadow = "0 0 0 8px rgba(245, 158, 11, 0.25)";
    setTimeout(() => {
      element.style.outline = "";
      element.style.outlineOffset = "";
      element.style.boxShadow = "";
    }, 12000);
  }

  function createPendingAdvance(status) {
    return {
      status,
      index: currentIndex,
      createdAt: Date.now(),
      returnUrl: getSurveyReturnUrl()
    };
  }

  function armManualSubmitAdvance() {
    const pending = createPendingAdvance("awaiting-submit");
    savePendingAdvance(pending);
    startSubmitCompletionWatcher(pending);
  }

  function markAdvanceAfterManualSubmit() {
    const pending = getPendingAdvance() || createPendingAdvance("submitted");
    pending.status = "submitted";
    pending.index = currentIndex;
    pending.createdAt = Date.now();
    pending.returnUrl = pending.returnUrl || getSurveyReturnUrl();
    savePendingAdvance(pending);
  }

  function savePendingAdvance(pending) {
    const text = JSON.stringify(pending);
    localStorage.setItem(ADVANCE_KEY, text);
    try {
      window.name = `${WINDOW_PENDING_PREFIX}${text}`;
    } catch (error) {
      console.warn("[SafeUserFiller] Failed to write window.name pending state:", error);
    }
  }

  function clearPendingAdvance() {
    localStorage.removeItem(ADVANCE_KEY);
    try {
      if (String(window.name || "").startsWith(WINDOW_PENDING_PREFIX)) window.name = "";
    } catch (error) {
      console.warn("[SafeUserFiller] Failed to clear window.name pending state:", error);
    }
  }

  function getPendingAdvance() {
    try {
      let raw = localStorage.getItem(ADVANCE_KEY);
      if (!raw && String(window.name || "").startsWith(WINDOW_PENDING_PREFIX)) {
        raw = String(window.name).slice(WINDOW_PENDING_PREFIX.length);
      }
      if (!raw) return null;
      const pending = JSON.parse(raw);
      if (!pending) return null;
      if (Date.now() - Number(pending.createdAt || 0) > 10 * 60 * 1000) {
        clearPendingAdvance();
        return null;
      }
      if (!localStorage.getItem(ADVANCE_KEY)) localStorage.setItem(ADVANCE_KEY, raw);
      return pending;
    } catch (error) {
      console.warn("[SafeUserFiller] Failed to read pending advance:", error);
      clearPendingAdvance();
      return null;
    }
  }

  function isOnReturnUrl(returnUrl) {
    if (!returnUrl) return false;
    try {
      const current = new URL(location.href);
      const target = new URL(returnUrl, location.href);
      current.searchParams.delete("_safeReload");
      target.searchParams.delete("_safeReload");
      return current.origin === target.origin
        && current.pathname === target.pathname
        && current.search === target.search;
    } catch (error) {
      return location.href.startsWith(returnUrl);
    }
  }

  function shouldReturnToSurvey(pending) {
    return Boolean(pending?.returnUrl && pending.status === "submitted" && !isOnReturnUrl(pending.returnUrl));
  }

  function maybeReturnToSurveyAfterSubmit(pending) {
    if (pending?.status === "awaiting-submit") {
      if (!isOnReturnUrl(pending.returnUrl)) {
        pending.status = "submitted";
        pending.createdAt = Date.now();
        savePendingAdvance(pending);
        scheduleReturnToSurvey(pending.returnUrl, 300);
        return true;
      }
      startSubmitCompletionWatcher(pending);
      return false;
    }
    if (!shouldReturnToSurvey(pending)) return false;
    const delay = Math.max(300, Number(config.returnAfterManualSubmitMs || 1500));
    updateStatus(`检测到已提交，${Math.round(delay / 100) / 10} 秒后回到问卷首页。`);
    scheduleReturnToSurvey(pending.returnUrl, delay);
    return true;
  }

  function maybeAdvanceAfterManualSubmit() {
    try {
      const pending = getPendingAdvance();
      if (!pending) return false;
      if (pending.status !== "submitted") return false;
      if (!pending || pending.index !== currentIndex) return false;
      if (shouldReturnToSurvey(pending)) return false;
      clearPendingAdvance();
      if (currentIndex < queue.length - 1) {
        currentIndex += 1;
        saveState();
        renderPanel();
        updateStatus(`已切换到下一份：${getCurrentItem()?.respondent_id || getCurrentItem()?.id || currentIndex + 1}`);
        return true;
      }
      return false;
    } catch (error) {
      console.warn("[SafeUserFiller] Failed to advance:", error);
      localStorage.removeItem(ADVANCE_KEY);
      return false;
    }
  }

  function isAutoChainEnabled() {
    return localStorage.getItem(AUTO_CHAIN_KEY) === "1";
  }

  function setAutoChainEnabled(enabled) {
    localStorage.setItem(AUTO_CHAIN_KEY, enabled ? "1" : "0");
  }

  function maybeAutoFillAfterAdvance(advanced) {
    if (!advanced || !isAutoChainEnabled()) return;
    window.setTimeout(async () => {
      try {
        updateStatus("连续辅助已开启：正在自动填入下一份。");
        await fillAllPages();
      } catch (error) {
        updateStatus(`连续辅助填入失败：${error.message}`);
      }
    }, 900);
  }

  function looksSubmitted() {
    const text = normalizeText(document.body?.innerText || "");
    return /提交成功|已提交|答卷已提交|问卷已提交|提交完成|感谢|完成答题|success/i.test(text);
  }

  function startSubmitCompletionWatcher(seedPending) {
    if (!seedPending?.returnUrl || seedPending.status !== "awaiting-submit") return;
    const startedAt = Date.now();
    const returnUrl = seedPending.returnUrl;
    const timer = window.setInterval(() => {
      const pending = getPendingAdvance();
      if (!pending || pending.status !== "awaiting-submit") {
        window.clearInterval(timer);
        return;
      }
      if (pending.index !== currentIndex) {
        window.clearInterval(timer);
        return;
      }
      const submitted = !isOnReturnUrl(returnUrl) || looksSubmitted();
      if (submitted) {
        pending.status = "submitted";
        pending.createdAt = Date.now();
        savePendingAdvance(pending);
        window.clearInterval(timer);
        scheduleReturnToSurvey(returnUrl, Math.max(300, Number(config.returnAfterManualSubmitMs || 1500)));
        return;
      }
      if (Date.now() - startedAt > 2 * 60 * 1000) window.clearInterval(timer);
    }, 500);
  }

  function promoteAwaitingSubmitOnPageExit() {
    const pending = getPendingAdvance();
    if (!pending || pending.status !== "awaiting-submit") return;
    pending.status = "submitted";
    pending.createdAt = Date.now();
    savePendingAdvance(pending);
  }

  function installLifecycleSubmitWatcher() {
    if (lifecycleSubmitWatcherInstalled) return;
    lifecycleSubmitWatcherInstalled = true;
    window.addEventListener("pagehide", promoteAwaitingSubmitOnPageExit, true);
    window.addEventListener("beforeunload", promoteAwaitingSubmitOnPageExit, true);
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (quoted) {
        if (char === "\"" && next === "\"") {
          cell += "\"";
          index += 1;
        } else if (char === "\"") {
          quoted = false;
        } else {
          cell += char;
        }
      } else if (char === "\"") {
        quoted = true;
      } else if (char === ",") {
        row.push(cell);
        cell = "";
      } else if (char === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else if (char !== "\r") {
        cell += char;
      }
    }
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((item) => item.some((value) => normalizeText(value)));
  }

  function queueFromCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error("CSV 至少需要表头和一行数据。");
    const headers = rows[0].map(normalizeText);
    return rows.slice(1).map((row, rowIndex) => {
      const item = { id: `CSV-${String(rowIndex + 1).padStart(3, "0")}`, answers: {} };
      headers.forEach((header, index) => {
        const value = normalizeText(row[index]);
        if (header) item[header] = value;
        if (header) item.answers[header] = value;
      });
      item.id = item.respondent_id || item.id;
      return item;
    });
  }

  function readFile(file, callback) {
    const reader = new FileReader();
    reader.onload = () => callback(String(reader.result || ""));
    reader.readAsText(file, "utf-8");
  }

  function downloadTemplateCsv() {
    const headers = ["respondent_id", "persona", ...getAllQuestions().map((question) => question.key)];
    const blob = new Blob([`${headers.join(",")}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "generic_survey_template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function updateStatus(message) {
    const status = document.getElementById("safe-user-filler-status");
    if (status) status.textContent = message;
  }

  function renderPanel() {
    if (panelClosed) return;
    const host = document.body || document.documentElement;
    if (!host) {
      window.setTimeout(renderPanel, 300);
      return;
    }

    let panel = document.getElementById("safe-user-filler-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "safe-user-filler-panel";
      host.appendChild(panel);
    }

    const active = config.surveyUrl && location.href.startsWith(config.surveyUrl);
    const current = getCurrentItem();
    panel.innerHTML = `
      <style>
        #safe-user-filler-panel {
          position: fixed; right: 16px; top: 72px; z-index: 2147483647;
          width: 390px; max-width: calc(100vw - 32px); background: #fff; color: #111827;
          border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 12px 30px rgba(0,0,0,.18);
          font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #safe-user-filler-panel * { box-sizing: border-box; }
        #safe-user-filler-panel header { display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid #e5e7eb; font-weight:700; }
        #safe-user-filler-panel main { padding:10px 12px 12px; }
        #safe-user-filler-panel button { min-height:30px; border:1px solid #9ca3af; border-radius:6px; background:#f9fafb; color:#111827; cursor:pointer; padding:5px 8px; font:inherit; }
        #safe-user-filler-panel button.primary { background:#1f6feb; border-color:#1f6feb; color:#fff; }
        #safe-user-filler-panel textarea { width:100%; min-height:160px; border:1px solid #d1d5db; border-radius:6px; padding:8px; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; resize:vertical; }
        #safe-user-filler-panel .row { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0; }
        #safe-user-filler-panel .meta { color:#4b5563; margin-bottom:8px; overflow-wrap:anywhere; }
        #safe-user-filler-status { color:#065f46; min-height:18px; overflow-wrap:anywhere; }
      </style>
      <header>
        <span>Safe User Filler</span>
        <button type="button" id="safe-user-filler-close">x</button>
      </header>
      <main>
        <div class="meta">配置：${config.name || "未命名"} / ${active ? "当前网址匹配" : "当前网址未匹配"}</div>
        <div class="meta">当前：${current ? current.id : "无"} / ${queue.length ? currentIndex + 1 : 0} of ${queue.length}</div>
        <div class="meta">连续辅助：${isAutoChainEnabled() ? "已开启" : "已关闭"}（手动提交后自动加载并填下一份）</div>
        <div class="meta">分页识别：首次自动识别并缓存</div>
        <div class="row">
          <button type="button" id="safe-user-filler-prev">上一份</button>
          <button type="button" id="safe-user-filler-next">下一份</button>
          <button type="button" id="safe-user-filler-fill">填当前页</button>
          <button type="button" id="safe-user-filler-fill-all" class="primary">填完整份</button>
          <button type="button" id="safe-user-filler-auto-chain">${isAutoChainEnabled() ? "关闭连续辅助" : "开启连续辅助"}</button>
          <button type="button" id="safe-user-filler-clear-cache">清除页缓存</button>
        </div>
        <textarea id="safe-user-filler-config-editor" spellcheck="false"></textarea>
        <input id="safe-user-filler-config-file" type="file" accept=".json,application/json" style="display:none" />
        <input id="safe-user-filler-csv-file" type="file" accept=".csv,text/csv" style="display:none" />
        <div class="row">
          <button type="button" id="safe-user-filler-save-config">保存配置</button>
          <button type="button" id="safe-user-filler-import-config">导入 JSON</button>
          <button type="button" id="safe-user-filler-import-csv">导入 CSV</button>
          <button type="button" id="safe-user-filler-template">CSV 表头</button>
        </div>
        <div id="safe-user-filler-status">不会自动提交；最终提交请手动点击。</div>
      </main>
    `;

    document.getElementById("safe-user-filler-config-editor").value = JSON.stringify(config, null, 2);
    document.getElementById("safe-user-filler-close").onclick = () => {
      panelClosed = true;
      panel.remove();
    };
    document.getElementById("safe-user-filler-prev").onclick = () => {
      currentIndex = Math.max(0, currentIndex - 1);
      saveState();
      renderPanel();
    };
    document.getElementById("safe-user-filler-next").onclick = () => {
      currentIndex = Math.min(Math.max(0, queue.length - 1), currentIndex + 1);
      saveState();
      renderPanel();
    };
    document.getElementById("safe-user-filler-fill").onclick = async () => {
      try {
        await fillPage();
      } catch (error) {
        updateStatus(`填入失败：${error.message}`);
      }
    };
    document.getElementById("safe-user-filler-fill-all").onclick = async () => {
      try {
        await fillAllPages();
      } catch (error) {
        updateStatus(`连续填入失败：${error.message}`);
      }
    };
    document.getElementById("safe-user-filler-auto-chain").onclick = () => {
      const enabled = !isAutoChainEnabled();
      setAutoChainEnabled(enabled);
      renderPanel();
      updateStatus(enabled
        ? "连续辅助已开启：手动提交后会自动切下一份并填完整份。"
        : "连续辅助已关闭。");
    };
    document.getElementById("safe-user-filler-clear-cache").onclick = () => {
      clearPageCache();
      renderPanel();
    };
    document.getElementById("safe-user-filler-save-config").onclick = () => {
      try {
        config = normalizeConfig(JSON.parse(document.getElementById("safe-user-filler-config-editor").value));
        saveState();
        renderPanel();
        updateStatus("配置已保存。");
      } catch (error) {
        updateStatus(`配置 JSON 保存失败：${error.message}`);
      }
    };
    document.getElementById("safe-user-filler-import-config").onclick = () => document.getElementById("safe-user-filler-config-file").click();
    document.getElementById("safe-user-filler-config-file").onchange = (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      readFile(file, (text) => {
        config = normalizeConfig(JSON.parse(text));
        saveState();
        renderPanel();
        updateStatus("配置 JSON 已导入。");
      });
    };
    document.getElementById("safe-user-filler-import-csv").onclick = () => document.getElementById("safe-user-filler-csv-file").click();
    document.getElementById("safe-user-filler-csv-file").onchange = (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      readFile(file, (text) => {
        queue = queueFromCsv(text);
        currentIndex = 0;
        saveState();
        renderPanel();
        updateStatus(`CSV 已导入：${queue.length} 条。`);
      });
    };
    document.getElementById("safe-user-filler-template").onclick = downloadTemplateCsv;
  }
  function getSurveyReturnUrl() {
    if (config.surveyUrl) return config.surveyUrl;

    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.delete("_safeReload");
    return url.origin + url.pathname;
  }
  function keepPanelAvailable() {
    const repair = () => {
      if (!panelClosed && !document.getElementById("safe-user-filler-panel")) renderPanel();
    };
    [250, 900, 1800, 3500].forEach((delay) => window.setTimeout(repair, delay));
    window.addEventListener("load", repair, { once: true });
    if (document.documentElement && window.MutationObserver) {
      const observer = new MutationObserver(repair);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function boot() {
    const isTargetSurvey = !config.surveyUrl || location.href.startsWith(config.surveyUrl);
    renderPanel();
    keepPanelAvailable();
    installLifecycleSubmitWatcher();
    const pending = getPendingAdvance();
    if (pending && maybeReturnToSurveyAfterSubmit(pending)) return;
    const advancedAfterSubmit = maybeAdvanceAfterManualSubmit();
    maybeAutoFillAfterAdvance(advancedAfterSubmit);
    if (!isTargetSurvey) return;
    installSubmitGuard();
  }

  boot();

  function addCacheBuster(url) {
    const target = new URL(url, location.href);
    target.searchParams.set("_safeReload", String(Date.now()));
    return target.toString();
  }

  function scheduleReturnToSurvey(returnUrl, firstDelay) {
    const delays = [
      firstDelay,
      Math.max(firstDelay + 1200, 2500),
      Math.max(firstDelay + 3000, 4500),
      Math.max(firstDelay + 5500, 7000)
    ];
    delays.forEach((delay) => {
      window.setTimeout(() => {
        window.location.replace(addCacheBuster(returnUrl));
      }, delay);
    });
  }

  function findSubmitButtonFromEvent(event) {
    const pattern = actionPattern(config.navigation?.submitText || []);
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const candidates = [
      ...path,
      event.target,
      event.target?.closest?.("button, input[type='submit'], input[type='button'], [role='button'], a, div, span, #ctlNext, .submitbtn")
    ].filter(Boolean);

    for (const element of candidates) {
      if (!(element instanceof Element) || !isVisible(element) || isDisabled(element)) continue;
      const text = visibleText(element);
      if (!pattern.test(text)) continue;
      return element;
    }
    return null;
  }

  function installSubmitGuard() {
    if (submitGuardInstalled) return;
    submitGuardInstalled = true;
    document.addEventListener("click", (event) => {
      const button = findSubmitButtonFromEvent(event);
      if (!button) return;

      markAdvanceAfterManualSubmit();
      const returnUrl = getSurveyReturnUrl();
      const delay = Math.max(300, Number(config.returnAfterManualSubmitMs || 1500));
      scheduleReturnToSurvey(returnUrl, delay);
    }, true);
  }

  window.SafeUserFiller = {
    getConfig: () => config,
    setConfig: (nextConfig) => {
      config = normalizeConfig(nextConfig);
      saveState();
      renderPanel();
    },
    getQueue: () => queue,
    setQueue: (nextQueue) => {
      queue = nextQueue;
      currentIndex = 0;
      saveState();
      renderPanel();
    },
    getCurrent: getCurrentItem,
    fillPage,
    fillAllPages,
    queueFromCsv,
    isAutoChainEnabled,
    setAutoChainEnabled,
    discoverQuestionsOnCurrentPage,
    clearPageCache
  };
})();
