# Website builder

OpenPortrait can build your studio's main website. It makes a **static site**: plain HTML, CSS and image files with no database and no server code. You can upload it to any static web host. We recommend **Cloudflare Pages**, which is free for a site like this and serves from a global network.

Open **Website** in the sidebar.

## What you can change

- **Template.** Three come with every install: Editorial (warm and serif), Studio (dark and cinematic) and Clean (bright, with the menu over a big opening photo). Choosing one sets its colors and fonts, which you can then change.
- **Colors, fonts and shape.** Background, text, soft text and accent colors, heading and body fonts, heading size and corner style. Fonts are bundled into the exported site, so visitors never load anything from a font service.
- **Pages.** Home, Portfolio, About, Services and Contact. Turn each on or off and set its menu label, tab title and search description.
- **Sections.** Every page is a stack of sections you can add, reorder and edit: hero, photo gallery, text, photo and text, services and pricing, testimonials, contact details and call to action.
- **Details.** Site name, tagline, website address, email, phone, location, links, footer text, search description and sharing photo.
- **Logo.** Use the logo from Settings, Galleries in place of the site name.

Changes save automatically and the preview updates after each save. The preview is the real site served by OpenPortrait, so what you see is what you upload.

## Photos

Pick photos from your galleries with **Choose photos**. Only the photos you explicitly pick are exported.

- The site gets web-size copies (up to 2000 px wide) rebuilt from your originals. Camera data, including GPS position and camera serial number, is not included.
- Original files, folder names and file names never appear on the site. Exported image names are hashes.
- Photos of clients become public when you upload the site. Only pick photos you have permission to show.
- You can pick from draft galleries too. A gallery's own status and password don't matter, because the site is separate from the gallery.

Add alt text to each photo. It helps people using screen readers and helps search engines.

## Publishing

Click **Publish**. OpenPortrait checks the site, lists anything to fix, and gives you a zip file.

### Cloudflare Pages (recommended)

1. Download the website and unzip it.
2. In Cloudflare, go to **Workers & Pages**, choose **Create**, then **Pages**, then **Upload assets**.
3. Name the project, drag in the unzipped folder and deploy.
4. Under the project's **Custom domains**, add your own domain.

To update the site later, change it in OpenPortrait, download it again and upload a new deployment to the same project.

### Other hosts

Any host that serves static files works: upload the contents of the zip to the web root. The `_headers` file sets caching and security headers on hosts that read it (Cloudflare Pages does). Other hosts work fine without it.

## Inquiry form

A static site can't receive form posts, so buttons that go to **Your inquiry form** link to the inquiry page on your OpenPortrait address. New inquiries land in Leads as usual. Set a public address under **Settings, Internet** for this to work. The contact section also shows your email, phone and links.

## Extensions

Extensions can add templates, fields in the builder's **More** tab, extra pages, CSS, head and body snippets, and extra files, through `api.site.registerTemplate` and `api.site.registerExtension` (see `apps/server/src/site/registry.ts`).
