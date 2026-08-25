(function setupInfoBarCarousel() {
  const mobileQuery = window.matchMedia("(max-width: 1100px)");
  const phoneQuery = window.matchMedia("(max-width: 1100px)");
  const bar = document.querySelector(".info-bar");
  const track = bar && bar.querySelector(".info-bar-carousel");
  const slides = track ? Array.from(track.querySelectorAll(".info-bar-item")) : [];

  if (!bar || !track || slides.length < 2) return;
  if (bar.dataset.infoBarCarouselInitialized === "true") return;
  bar.dataset.infoBarCarouselInitialized = "true";

  const AUTOPLAY_DELAY = 3500;
  const RESUME_DELAY = 2000;

  let activeIndex = 0;
  let autoplayTimer = 0;
  let resumeTimer = 0;
  let pointerId = null;
  let dragStartX = 0;
  let dragOffset = 0;
  let dots = [];
  let pagination = null;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function slideWidth() {
    return bar.getBoundingClientRect().width;
  }

  function render(animate) {
    track.classList.toggle("is-animating", Boolean(animate));
    track.style.transform = `translate3d(${(-activeIndex * slideWidth()) + dragOffset}px, 0, 0)`;
    dots.forEach((dot, index) => {
      const selected = index === activeIndex;
      dot.classList.toggle("is-active", selected);
      dot.setAttribute("aria-current", selected ? "true" : "false");
    });
  }

  function stopAutoplay() {
    window.clearInterval(autoplayTimer);
    autoplayTimer = 0;
  }

  function startAutoplay() {
    stopAutoplay();
    if (!mobileQuery.matches || reducedMotion.matches || document.hidden) return;
    autoplayTimer = window.setInterval(() => {
      activeIndex = (activeIndex + 1) % slides.length;
      dragOffset = 0;
      render(true);
    }, phoneQuery.matches ? 4500 : AUTOPLAY_DELAY);
  }

  function pauseForInteraction() {
    stopAutoplay();
    window.clearTimeout(resumeTimer);
  }

  function resumeAfterInteraction() {
    window.clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(startAutoplay, RESUME_DELAY);
  }

  function goTo(index, animate) {
    activeIndex = (index + slides.length) % slides.length;
    dragOffset = 0;
    render(animate);
  }

  function onPointerDown(event) {
    if (!mobileQuery.matches || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (event.target.closest(".info-bar-pagination")) {
      pauseForInteraction();
      return;
    }

    pointerId = event.pointerId;
    dragStartX = event.clientX;
    dragOffset = 0;
    pauseForInteraction();
    track.classList.remove("is-animating");
    bar.classList.add("is-interacting");
    bar.setPointerCapture(pointerId);
  }

  function onPointerMove(event) {
    if (event.pointerId !== pointerId) return;
    dragOffset = event.clientX - dragStartX;
    render(false);
  }

  function finishPointer(event) {
    if (event.pointerId !== pointerId) return;

    const threshold = Math.min(80, slideWidth() * 0.18);
    const nextIndex = Math.abs(dragOffset) >= threshold
      ? activeIndex + (dragOffset < 0 ? 1 : -1)
      : activeIndex;

    if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
    pointerId = null;
    bar.classList.remove("is-interacting");
    goTo(nextIndex, true);
    resumeAfterInteraction();
  }

  function cancelPointer(event) {
    if (event.pointerId !== pointerId) return;

    if (bar.hasPointerCapture(pointerId)) bar.releasePointerCapture(pointerId);
    pointerId = null;
    bar.classList.remove("is-interacting");
    goTo(activeIndex, true);
    resumeAfterInteraction();
  }

  function syncPagination() {
    if (!mobileQuery.matches || phoneQuery.matches) {
      if (pagination) pagination.remove();
      pagination = null;
      dots = [];
      return;
    }

    if (pagination) return;
    pagination = document.createElement("div");
    pagination.className = "info-bar-pagination";
    pagination.setAttribute("aria-label", "Choose information slide");

    dots = slides.map((slide, index) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "info-bar-dot";
      dot.setAttribute("aria-label", `Show information slide ${index + 1}`);
      dot.addEventListener("click", () => {
        pauseForInteraction();
        goTo(index, true);
        resumeAfterInteraction();
      });
      pagination.appendChild(dot);
      return dot;
    });

    bar.appendChild(pagination);
  }

  function enable() {
    if (bar.classList.contains("is-carousel-ready")) {
      syncPagination();
      render(false);
      startAutoplay();
      return;
    }

    bar.classList.add("is-carousel-ready");
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-roledescription", "carousel");
    bar.setAttribute("aria-label", "Good Frame information");
    track.setAttribute("aria-live", "polite");

    slides.forEach((slide, index) => {
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", `${index + 1} of ${slides.length}`);
    });

    syncPagination();
    render(false);
    startAutoplay();
  }

  function disable() {
    stopAutoplay();
    window.clearTimeout(resumeTimer);
    if (pointerId !== null && bar.hasPointerCapture(pointerId)) {
      bar.releasePointerCapture(pointerId);
    }
    pointerId = null;
    dragOffset = 0;
    bar.classList.remove("is-interacting");
    syncPagination();
    track.classList.remove("is-animating");
    track.style.removeProperty("transform");
  }

  bar.addEventListener("pointerdown", onPointerDown);
  bar.addEventListener("pointermove", onPointerMove);
  bar.addEventListener("pointerup", finishPointer);
  bar.addEventListener("pointercancel", cancelPointer);
  bar.addEventListener("mouseenter", pauseForInteraction);
  bar.addEventListener("mouseleave", resumeAfterInteraction);
  bar.addEventListener("focusin", pauseForInteraction);
  bar.addEventListener("focusout", resumeAfterInteraction);
  window.addEventListener("resize", () => mobileQuery.matches && render(false));
  document.addEventListener("visibilitychange", () => document.hidden ? stopAutoplay() : startAutoplay());
  const onMobileChange = (event) => event.matches ? enable() : disable();
  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener("change", onMobileChange);
    phoneQuery.addEventListener("change", () => {
      syncPagination();
      render(false);
      startAutoplay();
    });
    reducedMotion.addEventListener("change", startAutoplay);
  } else {
    mobileQuery.addListener(onMobileChange);
    phoneQuery.addListener(() => {
      syncPagination();
      render(false);
      startAutoplay();
    });
    reducedMotion.addListener(startAutoplay);
  }

  if (mobileQuery.matches) enable();
})();
