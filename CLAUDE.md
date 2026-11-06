# OpenPortrait

OpenPortrait is an open-source, self-hosted studio CRM for photographers. It runs as a single Docker container and installs as an Unraid app. It is built first for ERW Photography and published for any photographer to use.

- Product spec and architecture: [`docs/SPEC.md`](docs/SPEC.md). Read it before making structural changes, and update it when a decision changes.
- Brand assets, colors, and type: [`docs/brand/README.md`](docs/brand/README.md). Use the brand tokens; don't invent new accent colors.
- Naming: the product is **OpenPortrait**. Never call it "OpenPortrait Pro", which is reserved for a possible future paid edition. The image, repo, and Unraid template are all `openportrait`.
- Keep the app generic. Nothing specific to ERW Photography goes into code or defaults. Studio name, branding, and copy are settings.

## UI/UX Design Standards

Act as a senior product designer and frontend engineer.
Your goal is to produce production-quality applications with excellent UI/UX.

### Visual Design

* Avoid generic AI-generated designs and cookie-cutter layouts.
* Use intentional typography, spacing, color, and visual hierarchy.
* Create a cohesive visual identity across the application.
* Use professional, modern design patterns.
* Prioritize clarity and simplicity over unnecessary decoration.

### User Experience

* Make every interaction intuitive.
* Minimize unnecessary user steps.
* Provide clear feedback for user actions.
* Design thoughtful loading, empty, success, and error states.
* Ensure navigation is predictable.

### Responsive Design

* Design for mobile, tablet, and desktop.
* Avoid horizontal overflow.
* Ensure layouts adapt naturally to different screen sizes.

### Component Quality

* Maintain reusable components.
* Use consistent spacing and design tokens.
* Keep buttons, forms, cards, and navigation visually consistent.
* Avoid unnecessary component duplication.

### Quality Assurance

* Review every screen before considering it complete.
* Check accessibility and color contrast.
* Test real interactions.
* Inspect responsive layouts.
* Identify and fix visual inconsistencies.

### Important

Do not settle for a functional interface when it could be significantly better visually.
Think like a senior product designer before implementing UI changes.

## Merge rule

- Eric approves every pull request and every merge. Agents may create branches, commit and open a PR once Eric has asked for that change.
- Nothing is merged, approved or closed by an agent, and no agent pushes to `main`.
- Eric batches approved PRs. Each merge to `main` publishes an image, so merges wait for the batch.
- Sign-in, sessions, client-gallery access, payments, secrets and legal text need Eric's explicit "merge" in the thread.
- The head branch is deleted after merge (repository setting).
