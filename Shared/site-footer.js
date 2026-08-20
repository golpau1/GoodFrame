(() => {
  const mount = document.currentScript && document.currentScript.previousElementSibling;
  if (!mount || !mount.hasAttribute("data-site-footer")) return;

  const root = mount.dataset.root || "";
  const href = (path) => `${root}${path}`;
  const template = document.createElement("template");

  template.innerHTML = `
    <footer class="footer site-footer">
      <div class="site-footer-mobile">
        <nav class="site-footer-mobile-nav" aria-label="Footer navigation">
          <a href="${href("Print-Frame/print-frame.html")}">Print &amp; Frame</a>
          <a href="${href("Pricing/pricing.html")}">Pricing</a>
          <a href="${href("About Us/AboutUs.html")}">About Us</a>
          <a href="${href("FAQ/FAQ.html")}">FAQ</a>
          <a href="${href("About Us/AboutUs.html")}">Contact Us</a>
        </nav>
        <div class="site-footer-divider"></div>
        <div class="site-footer-contact">
          <a href="mailto:contact.goodframe@gmail.com">contact.goodframe@gmail.com</a>
          <a href="https://www.instagram.com/goodframeau/?hl=en">Instagram</a>
        </div>
        <div class="site-footer-divider"></div>
        <div class="site-footer-meta">
          <p>© Good Frame</p>
          <p>Gold Coast, Australia</p>
        </div>
      </div>

      <div class="footer-content site-footer-wide">
        <div class="footer-col">
          <h3 class="footer-title footer-girthquake">Navigation</h3>
          <ul>
            <li><a href="${href("Print-Frame/print-frame.html")}">Print &amp; Frame</a></li>
            <li><a href="${href("Pricing/pricing.html")}">Pricing</a></li>
            <li><a href="${href("About Us/AboutUs.html")}">Contact Us</a></li>
            <li><a href="${href("FAQ/FAQ.html")}">FAQ</a></li>
            <li><a href="${href("About Us/AboutUs.html")}">About Us</a></li>
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
