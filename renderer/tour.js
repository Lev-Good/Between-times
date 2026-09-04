'use strict';

/**
 * tour.js — מנוע המלווה האישי ומערכת חלון המדריך למשתמש
 * מנהל את הסיור האינטראקטיבי, הילת התאורה (Spotlight), חלונית ההסבר ומודאל המדריך המלא.
 */

window.BenHazmanimTour = (function () {
  const TOUR_STORAGE_KEY = 'benhazmanim_tour_completed';
  let currentStepIndex = 0;
  let isTourRunning = false;
  let activeCategory = 'all';

  const $ = (id) => document.getElementById(id);

  /* ==========================================================================
     בדיקת פתיחה ראשונה
     ========================================================================== */
  function isFirstTimeUser() {
    try {
      return !localStorage.getItem(TOUR_STORAGE_KEY);
    } catch {
      return false;
    }
  }

  function markTourDone() {
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, 'true');
    } catch { /* ignore */ }
  }

  /* ==========================================================================
     מנוע הסיור האינטראקטיבי (המלווה האישי)
     ========================================================================== */
  function startTour(fromIndex = 0) {
    if (!window.BenHazmanimGuide || !window.BenHazmanimGuide.TOUR_STEPS.length) return;
    
    // סגירת חלון העזרה אם הוא פתוח
    closeHelpModal();

    isTourRunning = true;
    currentStepIndex = Math.max(0, Math.min(fromIndex, window.BenHazmanimGuide.TOUR_STEPS.length - 1));

    const overlay = $('tourOverlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      document.body.classList.add('tour-active');
    }

    renderStep();
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('keydown', handleKeyNav);
    window.addEventListener('scroll', handleScroll, true);
  }

  function handleWindowResize() {
    if (!isTourRunning) return;
    positionSpotlight();
  }

  function handleScroll() {
    if (!isTourRunning) return;
    positionSpotlight();
  }

  function handleKeyNav(e) {
    if (!isTourRunning) return;
    if (e.key === 'Escape') {
      endTour();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      // ב-RTL, חץ שמאלה מתקדם קדימה
      nextStep();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      prevStep();
    }
  }

  function renderStep() {
    const steps = window.BenHazmanimGuide.TOUR_STEPS;
    const step = steps[currentStepIndex];
    if (!step) { endTour(); return; }

    // מעבר לשונית אוטומטי במידת הצורך
    if (step.tab) {
      const targetTabBtn = document.querySelector(`.tab-btn[data-tab="${step.tab}"]`);
      if (targetTabBtn && !targetTabBtn.classList.contains('active')) {
        targetTabBtn.click();
      }
    }

    // מעבר תת-לשונית אוטומטי בהגדרות
    if (step.subtab && typeof window.switchSettingsSubtab === 'function') {
      window.switchSettingsSubtab(step.subtab);
    }

    // תצוגת טקסטים
    $('tourTitle').textContent = step.title;
    $('tourText').innerHTML = step.text;
    $('tourStepCounter').textContent = `שלב ${currentStepIndex + 1} מתוך ${steps.length}`;

    // כפתור הקודם
    $('tourPrevBtn').classList.toggle('hidden', currentStepIndex === 0);

    // כפתור הבא
    const nextBtn = $('tourNextBtn');
    if (currentStepIndex === steps.length - 1) {
      nextBtn.textContent = 'סיום!';
      nextBtn.classList.add('btn-finish');
    } else {
      nextBtn.textContent = 'הבא';
      nextBtn.classList.remove('btn-finish');
    }

    // ציור נקודות התקדמות (dots)
    renderProgressDots(steps.length, currentStepIndex);

    // עדכון מיקום ומעקב רציף אחר האלמנט
    setTimeout(() => {
      updateSpotlight();
    }, 80);
  }

  function renderProgressDots(total, current) {
    const dotsContainer = $('tourDots');
    if (!dotsContainer) return;
    dotsContainer.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('span');
      dot.className = 'tour-dot' + (i === current ? ' active' : '') + (i < current ? ' completed' : '');
      dot.title = `שלב ${i + 1}`;
      dot.onclick = () => {
        currentStepIndex = i;
        renderStep();
      };
      dotsContainer.appendChild(dot);
    }
  }

  let trackingRaf = null;
  let currentTargetEl = null;

  function stopTracking() {
    if (trackingRaf) {
      cancelAnimationFrame(trackingRaf);
      trackingRaf = null;
    }
  }

  function startTracking(durationMs = 700) {
    stopTracking();
    const start = performance.now();
    function tick(now) {
      if (!isTourRunning) return;
      positionSpotlight();
      if (now - start < durationMs) {
        trackingRaf = requestAnimationFrame(tick);
      } else {
        trackingRaf = null;
        positionSpotlight();
      }
    }
    trackingRaf = requestAnimationFrame(tick);
  }

  function positionSpotlight() {
    if (!isTourRunning) return;
    const spotlight = $('tourSpotlight');
    const card = $('tourCard');
    if (!spotlight || !card) return;

    if (!currentTargetEl || currentTargetEl.offsetParent === null) {
      spotlight.style.opacity = '0';
      card.style.transform = 'translate(-50%, -50%)';
      card.style.top = '50%';
      card.style.left = '50%';
      return;
    }

    const rect = currentTargetEl.getBoundingClientRect();
    const pad = 8;
    const top = Math.max(0, rect.top - pad);
    const left = Math.max(0, rect.left - pad);
    const width = Math.max(20, rect.width + pad * 2);
    const height = Math.max(20, rect.height + pad * 2);

    spotlight.style.opacity = '1';
    spotlight.style.top = `${top}px`;
    spotlight.style.left = `${left}px`;
    spotlight.style.width = `${width}px`;
    spotlight.style.height = `${height}px`;

    // מיקום כרטיס ההדרכה מעל או מתחת לאלמנט
    const cardRect = card.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    let cardTop = rect.bottom + 16;
    let cardLeft = rect.left + (rect.width / 2) - (cardRect.width / 2);

    // אם אין מספיק מקום למטה, נמקם למעלה
    if (cardTop + cardRect.height > viewportHeight - 20) {
      cardTop = rect.top - cardRect.height - 16;
      if (cardTop < 10) {
        cardTop = Math.max(10, (viewportHeight - cardRect.height) / 2);
      }
    }

    // מניעת גלישה מצדי המסך
    cardLeft = Math.max(16, Math.min(cardLeft, viewportWidth - cardRect.width - 16));

    card.style.transform = 'none';
    card.style.top = `${cardTop}px`;
    card.style.left = `${cardLeft}px`;
  }

  function updateSpotlight() {
    if (!isTourRunning) return;
    const steps = window.BenHazmanimGuide.TOUR_STEPS;
    const step = steps[currentStepIndex];
    if (!step) return;

    // הסרת הדגשה מאלמנטים קודמים
    document.querySelectorAll('.tour-target-active').forEach(el => el.classList.remove('tour-target-active'));

    currentTargetEl = document.querySelector(step.target);

    if (currentTargetEl && currentTargetEl.offsetParent !== null) {
      currentTargetEl.classList.add('tour-target-active');
      currentTargetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }

    // מיקום ראשוני והתחלת מעקב רציף עד סיום הגלילה והאנימציות
    positionSpotlight();
    startTracking(700);
  }

  function nextStep() {
    const steps = window.BenHazmanimGuide.TOUR_STEPS;
    if (currentStepIndex < steps.length - 1) {
      currentStepIndex++;
      renderStep();
    } else {
      endTour();
    }
  }

  function prevStep() {
    if (currentStepIndex > 0) {
      currentStepIndex--;
      renderStep();
    }
  }

  function endTour() {
    isTourRunning = false;
    stopTracking();
    document.querySelectorAll('.tour-target-active').forEach(el => el.classList.remove('tour-target-active'));
    currentTargetEl = null;

    markTourDone();
    const overlay = $('tourOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      document.body.classList.remove('tour-active');
    }
    window.removeEventListener('resize', handleWindowResize);
    window.removeEventListener('keydown', handleKeyNav);
    window.removeEventListener('scroll', handleScroll, true);
  }

  /* ==========================================================================
     מודאל המדריך המלא (Help Modal & Knowledge Base)
     ========================================================================== */
  function openHelpModal(sectionId = null) {
    const modal = $('helpModal');
    if (!modal) return;

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    renderGuideNav();
    renderGuideContent();

    if (sectionId) {
      showSection(sectionId);
    } else {
      showSection('intro');
    }

    setTimeout(() => {
      const searchInput = $('guideSearchInput');
      if (searchInput) searchInput.focus();
    }, 100);
  }

  function closeHelpModal() {
    const modal = $('helpModal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  function renderGuideNav() {
    const nav = $('guideNav');
    if (!nav || !window.BenHazmanimGuide) return;
    nav.innerHTML = '';

    window.BenHazmanimGuide.SECTIONS.forEach((sec, idx) => {
      const item = document.createElement('button');
      item.className = 'guide-nav-item' + (idx === 0 ? ' active' : '');
      item.dataset.secId = sec.id;
      item.innerHTML = `
        <span class="guide-nav-icon">${sec.icon}</span>
        <span class="guide-nav-label">${sec.title}</span>
        ${sec.badge ? `<span class="guide-nav-badge">${sec.badge}</span>` : ''}
      `;
      item.onclick = () => showSection(sec.id);
      nav.appendChild(item);
    });
  }

  function showSection(id) {
    const buttons = document.querySelectorAll('.guide-nav-item');
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.secId === id));

    const contentEl = $('guideBody');
    if (!contentEl || !window.BenHazmanimGuide) return;

    const sec = window.BenHazmanimGuide.SECTIONS.find((s) => s.id === id);
    if (!sec) return;

    contentEl.innerHTML = `
      <article class="guide-article fade-in">
        <header class="guide-article-head">
          <div class="guide-article-badge">${sec.badge || 'פרק'}</div>
          <h2>${sec.title}</h2>
        </header>
        <div class="guide-article-content">
          ${sec.content}
        </div>
      </article>
    `;

    contentEl.scrollTop = 0;
  }

  function renderGuideContent() {
    const searchInput = $('guideSearchInput');
    if (searchInput) {
      searchInput.value = '';
      searchInput.oninput = (e) => filterGuide(e.target.value);
    }
  }

  function filterGuide(query) {
    const q = (query || '').trim().toLowerCase();
    const navItems = document.querySelectorAll('.guide-nav-item');

    if (!q) {
      navItems.forEach((it) => it.classList.remove('hidden'));
      return;
    }

    let firstMatchId = null;
    window.BenHazmanimGuide.SECTIONS.forEach((sec) => {
      const match = sec.title.toLowerCase().includes(q) ||
                    (sec.badge && sec.badge.toLowerCase().includes(q)) ||
                    sec.content.toLowerCase().includes(q);

      const navBtn = document.querySelector(`.guide-nav-item[data-sec-id="${sec.id}"]`);
      if (navBtn) {
        navBtn.classList.toggle('hidden', !match);
      }
      if (match && !firstMatchId) {
        firstMatchId = sec.id;
      }
    });

    if (firstMatchId) {
      showSection(firstMatchId);
    }
  }

  /* ==========================================================================
     אתחול אירועים וכפתורים
     ========================================================================== */
  function init() {
    // חיבור כפתורי המלווה
    const nextBtn = $('tourNextBtn');
    const prevBtn = $('tourPrevBtn');
    const skipBtn = $('tourSkipBtn');
    const closeX = $('tourCloseX');

    if (nextBtn) nextBtn.onclick = nextStep;
    if (prevBtn) prevBtn.onclick = prevStep;
    if (skipBtn) skipBtn.onclick = endTour;
    if (closeX) closeX.onclick = endTour;

    // חיבור סגירת מודאל העזרה
    const helpClose = $('helpModalClose');
    const helpModalBackdrop = $('helpModal');
    if (helpClose) helpClose.onclick = closeHelpModal;
    if (helpModalBackdrop) {
      helpModalBackdrop.onclick = (e) => {
        if (e.target === helpModalBackdrop) closeHelpModal();
      };
    }

    // כפתור הפעלת המלווה האישי מתוך מודאל העזרה
    const startTourFromHelp = $('startTourFromHelpBtn');
    if (startTourFromHelp) {
      startTourFromHelp.onclick = () => {
        startTour(0);
      };
    }

    // פתיחה אוטומטית בפעם הראשונה
    if (isFirstTimeUser()) {
      setTimeout(() => {
        startTour(0);
      }, 700);
    }
  }

  return {
    init,
    startTour,
    nextStep,
    prevStep,
    endTour,
    openHelpModal,
    closeHelpModal,
    isFirstTimeUser
  };
})();
