// The early-access address: the sign-up page on this site, also what the app's "Join early access" entry should open
// (HERFECT_EARLY_ACCESS_URL in project.yml, as an absolute address). Every [data-early-access] link opens it; while it
// is empty, or without JavaScript, they lead to the closing #early-access section.
const EARLY_ACCESS_URL = "early-access.html";

if (EARLY_ACCESS_URL) {
  for (const link of document.querySelectorAll("[data-early-access]")) {
    link.href = EARLY_ACCESS_URL;
    link.rel = "noopener";
  }
}

const header = document.querySelector(".site-header");
const toggle = document.querySelector(".nav-toggle");
const menu = document.getElementById("site-menu");

if (toggle && menu) {
  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    header.classList.toggle("menu-open", open);
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
}

if (header) {
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}
