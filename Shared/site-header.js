(function renderSiteHeader() {
  const mount = document.currentScript && document.currentScript.previousElementSibling;

  if (!mount || !mount.hasAttribute("data-site-header")) return;

  const root = mount.dataset.root || "";
  const cartHref = mount.dataset.cartHref || `${root}cart.html`;
  const href = (path) => `${root}${path}`;
  const template = document.createElement("template");

  template.innerHTML = `
    <header class="site-announcement">
      <div class="top-banner">Free Shipping Over $100 - Frame Now</div>
    </header>

    <div class="secondary-header site-navigation">
      <a href="${href("index.html")}" class="header-title header-title--logo" aria-label="Good Frame home">
        <svg class="header-logo" viewBox="333 1534 5450 770" aria-hidden="true" focusable="false">
          <image href="${href("Assets/good-frame-logo.png?v=20260818-v5")}" width="6000" height="4000"></image>
        </svg>
      </a>

      <nav class="nav" aria-label="Primary navigation">
        <a href="${href("Print-Frame/print-frame.html")}">Print &amp; Frame</a>
        <a href="${href("Pricing/pricing.html")}">Pricing</a>
        <a href="${href("About Us/AboutUs.html")}">About Us</a>
        <a href="${href("FAQ/FAQ.html")}">FAQ</a>
      </nav>

      <div class="header-actions">
        <a href="${cartHref}" class="cart-nav" id="cartNav" aria-label="View cart">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="9" cy="21" r="1"></circle>
            <circle cx="20" cy="21" r="1"></circle>
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
          </svg>
          <span class="cart-count">0</span>
        </a>

        <div class="burger-menu" id="burgerMenu" role="button" tabindex="0" aria-label="Open navigation menu" aria-controls="mobileNav" aria-expanded="false">
          <span class="burger-line"></span>
          <span class="burger-line"></span>
          <span class="burger-line"></span>
        </div>
      </div>
    </div>

    <div class="mobile-nav-overlay" id="mobileNavOverlay"></div>

    <div class="mobile-nav" id="mobileNav" aria-label="Mobile navigation">
      <div class="mobile-nav-close" id="mobileNavClose" role="button" tabindex="0" aria-label="Close navigation menu">&times;</div>
      <a href="${href("index.html")}">Home</a>
      <a href="${href("Print-Frame/print-frame.html")}">Print &amp; Frame</a>
      <a href="${href("Pricing/pricing.html")}">Pricing</a>
      <a href="${href("About Us/AboutUs.html")}">About Us</a>
      <a href="${href("FAQ/FAQ.html")}">FAQ</a>
    </div>
  `;

  const fragment = template.content;
  const burger = fragment.querySelector("#burgerMenu");
  const mobileNav = fragment.querySelector("#mobileNav");
  const close = fragment.querySelector("#mobileNavClose");

  const normalisePath = (path) => path
    .replace(/\/index\.html$/, "/")
    .replace(/\/+$/, "/");
  const currentPath = normalisePath(window.location.pathname);

  fragment.querySelectorAll(".nav a, .mobile-nav a").forEach((link) => {
    const linkPath = normalisePath(new URL(link.href, window.location.href).pathname);
    if (linkPath === currentPath) link.setAttribute("aria-current", "page");
  });

  [burger, close].forEach((control) => {
    control.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      control.click();
    });
  });

  new MutationObserver(() => {
    burger.setAttribute("aria-expanded", String(mobileNav.classList.contains("active")));
  }).observe(mobileNav, { attributes: true, attributeFilter: ["class"] });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileNav.classList.contains("active")) close.click();
  });

  mount.replaceWith(fragment);
})();
