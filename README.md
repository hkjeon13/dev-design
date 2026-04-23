# Dev Design

Dev Design is a local macOS visual editor for React UI projects. It opens a project into an internal snapshot, analyzes JSX/CSS structure, lets you edit styles and JSX structure in the snapshot, then applies selected changes back to the original project through a diff review step.

## Development

```bash
npm install
npm run tauri dev
```

The current MVP supports Vite and Next-style React projects, Tailwind class editing, CSS/CSS Modules rule editing, basic JSX structure transforms, embedded preview startup, and manual sync with backups.
