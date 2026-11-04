// Applies the saved appearance before first paint (an external file, because the CSP forbids inline scripts).
try {
  var t = localStorage.getItem("op-theme");
  if (t === "light" || t === "dark") {
    document.documentElement.setAttribute("data-theme", t);
    var m = document.createElement("meta");
    m.name = "theme-color";
    m.content = t === "dark" ? "#151412" : "#f3eee5";
    document.head.appendChild(m);
  }
} catch (e) {}
