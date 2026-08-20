(() => {
  const viewport = document.querySelector(".gallery-row");
  const track = viewport?.querySelector(".gallery-carousel");

  if (!viewport || !track) return;

  const phoneQuery = window.matchMedia("(max-width: 767px)");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const slides = Array.from(track.querySelectorAll(".gallery-image")).slice(0, 5);
  const autoplayDelay = 4500;
  let index = 0;
  let autoplayTimer = null;
  let pointerId = null;
  let startX = 0;
  let dragX = 0;

  function isActive() {
    return phoneQuery.matches;
  }

  function render(animate = true) {
    if (!isActive()) return;
    const useTransition = animate && !reducedMotionQuery.matches;
    track.style.transition = useTransition ? "transform 500ms ease" : "none";
    track.style.transform = `translate3d(-${index * 100}%, 0, 0)`;
  }

  function stopAutoplay() {
    window.clearInterval(autoplayTimer);
    autoplayTimer = null;
  }

  function startAutoplay() {
    stopAutoplay();
    if (!isActive() || reducedMotionQuery.matches || document.hidden) return;
    autoplayTimer = window.setInterval(() => {
      const wrapping = index === slides.length - 1;
      index = wrapping ? 0 : index + 1;
      render(!wrapping);
    }, autoplayDelay);
  }

  function activate() {
    if (!isActive()) {
      stopAutoplay();
      track.style.removeProperty("transform");
      track.style.removeProperty("transition");
      return;
    }
    index = Math.min(index, slides.length - 1);
    render(false);
    startAutoplay();
  }

  viewport.addEventListener("pointerdown", (event) => {
    if (!isActive() || event.pointerType === "mouse" && event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    dragX = 0;
    stopAutoplay();
    viewport.setPointerCapture?.(pointerId);
    track.style.transition = "none";
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!isActive() || event.pointerId !== pointerId) return;
    dragX = event.clientX - startX;
    const pullingPastStart = index === 0 && dragX > 0;
    const pullingPastEnd = index === slides.length - 1 && dragX < 0;
    const visibleDrag = pullingPastStart || pullingPastEnd ? 0 : dragX;
    track.style.transform = `translate3d(calc(-${index * 100}% + ${visibleDrag}px), 0, 0)`;
  });

  function finishSwipe(event) {
    if (event.pointerId !== pointerId) return;
    let wrapping = false;
    if (Math.abs(dragX) >= 45) {
      if (dragX < 0) {
        wrapping = index === slides.length - 1;
        index = wrapping ? 0 : index + 1;
      } else {
        wrapping = index === 0;
        index = wrapping ? slides.length - 1 : index - 1;
      }
    }
    pointerId = null;
    render(!wrapping);
    startAutoplay();
  }

  viewport.addEventListener("pointerup", finishSwipe);
  viewport.addEventListener("pointercancel", finishSwipe);
  viewport.addEventListener("mouseenter", stopAutoplay);
  viewport.addEventListener("mouseleave", startAutoplay);
  viewport.addEventListener("focusin", stopAutoplay);
  viewport.addEventListener("focusout", startAutoplay);
  document.addEventListener("visibilitychange", startAutoplay);
  phoneQuery.addEventListener("change", activate);
  reducedMotionQuery.addEventListener("change", activate);
  activate();
})();
