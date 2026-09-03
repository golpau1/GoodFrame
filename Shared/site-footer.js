(() => {
  const mount = document.currentScript && document.currentScript.previousElementSibling;
  if (!mount || !mount.hasAttribute("data-site-footer")) return;

  const root = mount.dataset.root || "";
  const href = (path) => `${root}${path}`;
  const template = document.createElement("template");

  template.innerHTML = `
    <footer class="footer site-footer">
      <div class="site-footer-mobile">
        <div class="site-footer-mobile-word">Good Frame</div>
        <div class="site-footer-mobile-grid">
          <nav class="site-footer-mobile-nav" aria-label="Footer navigation">
            <span class="site-footer-eyebrow">Explore</span>
            <a href="/print-and-frame-online">Print &amp; Frame</a>
            <a href="/printing-framing-prices">Pricing</a>
            <a href="/about">About Us</a>
            <a href="/printing-framing-faq">FAQ</a>
            <a href="/about">Contact Us</a>
          </nav>
          <div class="site-footer-contact">
            <span class="site-footer-eyebrow">Connect</span>
            <a class="site-footer-icon-link" href="https://www.instagram.com/goodframeau/?hl=en">
              <span class="site-footer-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none"/></svg>
              </span>
              goodframeau
            </a>
            <a class="site-footer-icon-link" href="mailto:contact.goodframe@gmail.com">
              <span class="site-footer-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2.4"/><path d="M4 6.5l8 6.2 8-6.2"/></svg>
              </span>
              contact.goodframe@gmail.com
            </a>
          </div>
        </div>
        <div class="site-footer-divider"></div>
        <div class="site-footer-meta">
          <p>Gold Coast, Australia</p>
          <p>© Good Frame</p>
        </div>
      </div>

      <div class="footer-content site-footer-wide">
        <div class="footer-col">
          <h3 class="footer-title footer-girthquake">Navigation</h3>
          <ul>
            <li><a href="/print-and-frame-online">Print &amp; Frame</a></li>
            <li><a href="/printing-framing-prices">Pricing</a></li>
            <li><a href="/about">Contact Us</a></li>
            <li><a href="/printing-framing-faq">FAQ</a></li>
            <li><a href="/about">About Us</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h3 class="footer-title footer-girthquake">Contact</h3>
          <p><a href="mailto:contact.goodframe@gmail.com">contact.goodframe@gmail.com</a></p>
        </div>
        <div class="footer-col">
          <h3 class="footer-title footer-girthquake">Social</h3>
          <ul><li><a href="https://www.instagram.com/goodframeau/?hl=en">Instagram</a></li></ul>
        </div>
      </div>
    </footer>
  `;

  mount.replaceWith(template.content);
})();
