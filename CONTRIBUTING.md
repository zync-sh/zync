# Contributing to Zync

Thank you for your interest in contributing to Zync. This document provides guidelines and instructions for contributing.

## Getting Started

1. **Fork** the [repository](https://github.com/gajendraxdev/zync) on GitHub.

2. **Clone your fork** and add the upstream remote:
   ```bash
   git clone https://github.com/YOUR_USERNAME/zync.git
   cd zync
   git remote add upstream https://github.com/gajendraxdev/zync.git
   ```

3. Ensure you have the [prerequisites](./README.md#prerequisites) installed (Node.js, Rust, platform-specific dependencies).

4. Run `npm install` and `npm run tauri dev` to start the development environment.

**Staying in sync:** Before starting new work, pull the latest from upstream:
   ```bash
   git fetch upstream
   git checkout main
   git merge upstream/main
   ```

## Development Workflow

1. Create a new branch from `main` for your changes:
   ```bash
   git checkout -b fix/your-fix-name
   # or
   git checkout -b feature/your-feature-name
   ```

2. Make your changes. Follow existing code style and conventions.

3. Run the type checker and ensure the app builds:
   ```bash
   npm run type-check
   npm run tauri build
   ```

4. Commit with clear, descriptive messages:
   ```bash
   git commit -m "fix: resolve SSH connection timeout on slow networks"
   ```

5. Push to your fork and open a Pull Request against the main repository.

## Code Conventions

- **Frontend**: TypeScript, React functional components, Zustand for state.
- **Backend**: Rust, async/await where appropriate.
- **Naming**: Use descriptive names; prefer `snake_case` in Rust and `camelCase` in TypeScript.

## Pull Request Guidelines

- Keep PRs focused and reasonably sized.
- Add a clear title and description.
- Reference any related issues.
- Ensure CI passes (if applicable).

## Questions or Ideas?

Open an [Issue](https://github.com/gajendraxdev/zync/issues) to report bugs, request features, or ask questions.
