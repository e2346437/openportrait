/** The stylesheet every exported site shares. Templates add their own rules after it. Colors and fonts are CSS variables. */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
:root{--line:color-mix(in srgb,var(--text) 14%,transparent);--surface:color-mix(in srgb,var(--text) 5%,var(--bg));--wrap:1180px;--gap:clamp(12px,1.6vw,22px);--pad:clamp(20px,5vw,56px)}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-b);font-size:1.0625rem;line-height:1.65;-webkit-font-smoothing:antialiased}
img{max-width:100%;height:auto;display:block}
a{color:var(--accent);text-underline-offset:.2em}
a:hover{text-decoration-thickness:2px}
h1,h2,h3{font-family:var(--font-h);font-weight:var(--h-weight,400);line-height:1.15;margin:0 0 .5em;letter-spacing:var(--h-tracking,-.01em)}
h1{font-size:calc(clamp(2.4rem,6vw,4.6rem)*var(--h-scale))}
h2{font-size:calc(clamp(1.7rem,3.4vw,2.6rem)*var(--h-scale))}
h3{font-size:1.3rem}
p{margin:0 0 1em}
.wrap{max-width:var(--wrap);margin:0 auto;padding:0 var(--pad)}
.skip{position:absolute;left:-999px;top:8px;background:var(--text);color:var(--bg);padding:8px 14px;border-radius:var(--radius);z-index:100}
.skip:focus{left:8px}
.site-header{position:relative;z-index:10}
.site-header .wrap{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-top:22px;padding-bottom:22px;flex-wrap:wrap}
.brand{font-family:var(--font-h);font-size:1.55rem;color:var(--text);text-decoration:none;letter-spacing:var(--h-tracking,-.01em);line-height:1}
.brand img{height:44px;width:auto}
.menu{display:flex;gap:clamp(14px,2.4vw,32px);flex-wrap:wrap}
.menu a{color:var(--text);text-decoration:none;font-size:.95rem;padding:6px 0;border-bottom:2px solid transparent}
.menu a:hover,.menu a[aria-current=page]{border-bottom-color:var(--accent)}
[data-header=centered] .site-header .wrap{flex-direction:column;justify-content:center;text-align:center}
[data-header=overlay] .site-header{position:absolute;inset:0 0 auto 0}
[data-header=overlay] .site-header .brand,[data-header=overlay] .site-header .menu a{color:var(--on-image,#fff);text-shadow:0 1px 18px rgba(0,0,0,.35)}
.blk{padding:clamp(40px,7vw,96px) 0}
.blk>.wrap>h2{margin-bottom:.7em}
.center{text-align:center}
.lead{color:var(--muted);font-size:1.15em;max-width:42rem}
.center .lead{margin-left:auto;margin-right:auto}
.btn{display:inline-block;padding:.85em 1.7em;background:var(--accent);color:var(--accent-ink,#fff);border-radius:calc(var(--radius)*4);text-decoration:none;font-size:.95rem;font-weight:600;letter-spacing:.02em;border:2px solid var(--accent)}
.btn:hover{filter:brightness(1.08)}
.btn.ghost{background:transparent;color:inherit;border-color:currentColor}
.blk-hero{position:relative;padding:0;display:grid;align-items:end;color:var(--on-image,#fff);background:var(--surface);overflow:hidden}
.blk-hero.noimg{color:var(--text)}
.blk-hero .hero-img,.blk-hero .hero-img img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.blk-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.55),rgba(0,0,0,.05) 60%)}
.blk-hero.noimg::after{display:none}
.blk-hero .wrap{position:relative;z-index:2;padding-top:calc(var(--pad)*2);padding-bottom:calc(var(--pad)*1.4);width:100%}
.blk-hero.h-full{min-height:100svh}.blk-hero.h-tall{min-height:78svh}.blk-hero.h-short{min-height:44svh}
.blk-hero .sub{font-size:1.25rem;max-width:36rem;margin:0 0 1.4em;opacity:.92}
.blk-hero.a-center{text-align:center}.blk-hero.a-center .sub{margin-left:auto;margin-right:auto}
.blk-hero .btn{--accent-ink:#111;background:#fff;border-color:#fff;color:#111}
.blk-hero.noimg .btn{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,#fff)}
.prose{max-width:42rem}.center .prose{margin:0 auto}
.gallery{margin-top:1.4em}
.gallery a{display:block;overflow:hidden;border-radius:var(--radius);background:var(--surface);cursor:zoom-in}
.gallery img{width:100%;height:100%;transition:transform .5s ease,opacity .3s}
.gallery a:hover img{transform:scale(1.025)}
.gallery.masonry{columns:var(--cols) 260px;column-gap:var(--gap)}
.gallery.masonry a{break-inside:avoid;margin-bottom:var(--gap)}
.gallery.grid{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:var(--gap)}
.gallery.grid a{aspect-ratio:1/1}.gallery.grid img{object-fit:cover}
.gallery.rows{display:flex;flex-wrap:wrap;gap:var(--gap)}
.gallery.rows a{flex:var(--r) 1 calc(var(--r)*17rem);min-width:0}
.gallery.rows::after{content:"";flex-grow:1e6}
.gallery figure{margin:0}
.gallery figcaption,.pcap{font-size:.85rem;color:var(--muted);padding:.5em .1em 0}
@media(max-width:720px){.gallery.masonry{columns:2 140px}.gallery.grid{grid-template-columns:repeat(2,1fr)}.gallery.rows a{flex-basis:calc(var(--r)*9rem)}}
.split{display:grid;grid-template-columns:1fr 1fr;gap:clamp(24px,5vw,72px);align-items:center}
.split.right .split-img{order:2}
.split-img img{width:100%;border-radius:var(--radius)}
@media(max-width:820px){.split{grid-template-columns:1fr}.split.right .split-img{order:0}}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:var(--gap);margin-top:1.6em}
.card{background:var(--surface);border-radius:calc(var(--radius)*2);padding:clamp(20px,3vw,32px);border:1px solid var(--line)}
.card h3{margin-bottom:.2em}.price{font-family:var(--font-h);font-size:1.5rem;color:var(--accent);margin:0 0 .6em}
.card p:last-child{margin-bottom:0;color:var(--muted)}
.quotes{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:clamp(24px,4vw,56px);margin-top:1.6em}
.quotes blockquote{margin:0;font-family:var(--font-h);font-size:1.35rem;line-height:1.4}
.quotes cite{display:block;margin-top:.8em;font-family:var(--font-b);font-size:.9rem;font-style:normal;color:var(--muted)}
.contact-grid{display:flex;gap:clamp(24px,5vw,72px);flex-wrap:wrap;margin-top:1.4em}
.contact-grid dl{margin:0}.contact-grid dt{font-size:.8rem;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-top:1em}
.contact-grid dd{margin:.1em 0 0}
.blk-cta{background:var(--surface);text-align:center}
.site-footer{border-top:1px solid var(--line);padding:36px 0;color:var(--muted);font-size:.9rem}
.site-footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.site-footer a{color:inherit}
.lb{position:fixed;inset:0;background:rgba(10,10,10,.94);z-index:1000;display:none;align-items:center;justify-content:center;padding:4vw}
.lb.open{display:flex}.lb img{max-height:88vh;max-width:92vw;width:auto;object-fit:contain;border-radius:2px}
.lb button{position:absolute;background:none;border:0;color:#fff;font-size:2rem;cursor:pointer;padding:16px;line-height:1;opacity:.8}
.lb button:hover,.lb button:focus-visible{opacity:1}
.lb .x{top:6px;right:10px}.lb .p{left:6px;top:50%}.lb .n{right:6px;top:50%}
.lb .cap{position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#ddd;font-size:.9rem}
.empty{border:2px dashed var(--line);border-radius:var(--radius);padding:40px;text-align:center;color:var(--muted)}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;

/** Opens gallery photos full screen with arrow keys and swipe-free tap navigation. No libraries, no tracking. */
export const SITE_JS = `(function(){
var links=[].slice.call(document.querySelectorAll('.gallery a[data-full]'));if(!links.length)return;
var lb=document.createElement('div');lb.className='lb';lb.setAttribute('role','dialog');lb.setAttribute('aria-modal','true');lb.setAttribute('aria-label','Photo viewer');
lb.innerHTML='<button class="x" aria-label="Close">\\u00d7</button><button class="p" aria-label="Previous">\\u2039</button><img alt=""><button class="n" aria-label="Next">\\u203a</button><div class="cap"></div>';
document.body.appendChild(lb);var img=lb.querySelector('img'),cap=lb.querySelector('.cap'),i=0,group=[];
function show(k){i=(k+group.length)%group.length;var a=group[i];img.src=a.getAttribute('data-full');img.alt=a.getAttribute('data-alt')||'';cap.textContent=a.getAttribute('data-cap')||'';}
function open(a){group=links.filter(function(l){return l.closest('.gallery')===a.closest('.gallery')});show(group.indexOf(a));lb.classList.add('open');lb.querySelector('.x').focus();}
function close(){lb.classList.remove('open');img.removeAttribute('src');}
links.forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();open(a);});});
lb.querySelector('.x').onclick=close;lb.querySelector('.p').onclick=function(){show(i-1)};lb.querySelector('.n').onclick=function(){show(i+1)};
lb.addEventListener('click',function(e){if(e.target===lb)close();});
document.addEventListener('keydown',function(e){if(!lb.classList.contains('open'))return;if(e.key==='Escape')close();if(e.key==='ArrowLeft')show(i-1);if(e.key==='ArrowRight')show(i+1);});
})();`;
