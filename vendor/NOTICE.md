# Vendored third-party assets

This directory vendors (self-hosts, rather than loading from a CDN) two
open-source front-end libraries used purely for presentation:

- **Bootstrap 5.3.3** — https://getbootstrap.com/ — MIT License —
  © 2011–2024 The Bootstrap Authors
- **Bootstrap Icons 1.11.3** — https://icons.getbootstrap.com/ — MIT
  License — © 2019–2024 The Bootstrap Authors

Files are unmodified builds fetched from the projects' own GitHub
releases (`twbs/bootstrap` and `twbs/icons`). See each project's
repository for full license text. Vendoring them here (instead of a CDN
`<script>`/`<link>` tag) means the prototype has no runtime dependency on
third-party network availability.
