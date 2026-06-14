---
title: Glossary
group: Getting Started
order: 4
icon: 📖
---

# Glossary

Key terms and concepts used throughout kontexta Publish documentation.

```glossary
- term: kontexta
  definition: "A local-first knowledge and context engine for AI coding agents. Stores markdown notes in a git-versioned vault, indexes them with SQLite + FTS5, and exposes them through a Model Context Protocol (MCP) server."
- term: vault
  definition: "The storage location for markdown knowledge files. By default located at ~/.local/share/kontexta/knowledge/ on Linux, ~/Library/Application Support/kontexta/knowledge/ on macOS, or %APPDATA%\\kontexta\\knowledge\\ on Windows."
- term: MCP
  definition: "Model Context Protocol — an open standard for connecting AI models to external data sources, tools, and services. Enables AI agents to search, read, write, and organize knowledge files."
- term: FTS5
  definition: "Full-Text Search version 5, SQLite's built-in full-text search engine. Used by kontexta to index and search markdown files efficiently."
- term: frontmatter
  definition: "YAML metadata at the top of a markdown file enclosed in --- delimiters. Used to control document ordering, grouping, and display properties."
- term: mermaid
  definition: "A JavaScript diagramming and charting tool that renders markdown-inspired text definitions to create and modify complex diagrams. Supported in kontexta Publish for flowcharts, sequence diagrams, and more."
- term: SPA
  definition: "Single Page Application — a web application that loads a single HTML page and dynamically updates content as the user interacts with the app. kontexta Publish generates a self-contained SPA."
- term: hash routing
  definition: "A client-side routing technique that uses the URL hash fragment (#) to determine which content to display. Enables deep linking and browser history navigation without server configuration."
- term: scroll-spy
  definition: "A UI pattern that automatically highlights the current section in the table of contents as the user scrolls through the page content."
- term: kxta-core
  definition: "The core kontexta library that provides vault management, file indexing, git integration, and MCP tool implementations. Used by kontexta Publish to read knowledge files."
- term: pipeline
  definition: "The build process that reads markdown files, renders them to HTML, builds navigation and search indexes, and assembles the final single-file HTML output."
- term: seed docs
  definition: "Default documentation files bundled with kontexta Publish. Shown when no vault documents are found, providing immediate documentation about the tool itself."
- term: three-pane layout
  definition: "The default kontexta Publish layout with three columns: sidebar navigation (left), main content area (center), and table of contents (right)."
```

## Usage

To add your own glossary terms, use the `glossary` block in any markdown file:

```markdown
```glossary
- term: YourTerm
  definition: Your definition here.
```
```

Terms are automatically:
- Sorted alphabetically
- Indexed for search
- Displayed in a clean grid layout
