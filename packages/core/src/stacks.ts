/**
 * Stack registry — the single source of truth for every supported stack.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * To add a new framework / language:
 *   1. Add one entry here
 *   2. (Optional) Add detection rule in apps/api/src/lib/stack-detector.ts
 *   3. Done — types, schemas, constants all derive automatically
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   import { STACKS, STACK_IDS, LANGUAGES, type StackId } from "@repo/core";
 *
 *   STACKS.nextjs.runtimeImage   // "node:22"
 *   STACKS.go.defaultPort        // 8080
 *   STACK_IDS                    // ["nextjs", "nuxt", ... ] — auto-generated
 */

// ─── Language definitions ────────────────────────────────────────────────────

export interface LanguageDefinition {
  name: string;
  /** Default build image — used when stack doesn't override */
  buildImage: string;
  /** Default runtime image */
  runtimeImage: string;
  /** Package managers available for this language */
  packageManagers: readonly string[];
  /**
   * Tools required on bare metal to build/run this language.
   * Used by the toolchain catalog to validate and install prerequisites.
   * Empty array means no tool validation needed (e.g. multi-language, docker).
   */
  requiredTools: readonly string[];
}

export const LANGUAGES = {
  javascript: {
    name: "JavaScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
    requiredTools: ["node", "npm"],
  },
  typescript: {
    name: "TypeScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
    requiredTools: ["node", "npm"],
  },
  go: {
    name: "Go",
    buildImage: "golang:1.22-alpine",
    runtimeImage: "alpine:3.19",
    packageManagers: ["go"],
    requiredTools: ["go"],
  },
  rust: {
    name: "Rust",
    buildImage: "rust:1.77-slim",
    runtimeImage: "debian:bookworm-slim",
    packageManagers: ["cargo"],
    requiredTools: ["rustc", "cargo"],
  },
  python: {
    name: "Python",
    buildImage: "python:3.12-slim",
    runtimeImage: "python:3.12-slim",
    packageManagers: ["pip", "poetry", "pipenv", "uv"],
    requiredTools: ["python3", "pip"],
  },
  ruby: {
    name: "Ruby",
    buildImage: "ruby:3.3-slim",
    runtimeImage: "ruby:3.3-slim",
    packageManagers: ["bundler"],
    requiredTools: ["ruby", "bundler"],
  },
  php: {
    name: "PHP",
    buildImage: "php:8.3-cli",
    runtimeImage: "php:8.3-fpm",
    packageManagers: ["composer"],
    requiredTools: ["php", "composer"],
  },
  java: {
    name: "Java",
    buildImage: "eclipse-temurin:21-jdk-alpine",
    runtimeImage: "eclipse-temurin:21-jre-alpine",
    packageManagers: ["maven", "gradle"],
    requiredTools: ["java", "javac"],
  },
  csharp: {
    name: "C#",
    buildImage: "mcr.microsoft.com/dotnet/sdk:8.0",
    runtimeImage: "mcr.microsoft.com/dotnet/aspnet:8.0",
    packageManagers: ["dotnet"],
    requiredTools: ["dotnet"],
  },
  elixir: {
    name: "Elixir",
    buildImage: "elixir:1.16-alpine",
    runtimeImage: "elixir:1.16-alpine",
    packageManagers: ["mix"],
    requiredTools: ["elixir", "mix"],
  },
  multi: {
    name: "Multi-language",
    buildImage: "ubuntu:22.04",
    runtimeImage: "ubuntu:22.04",
    packageManagers: [],
    requiredTools: [],
  },
} as const satisfies Record<string, LanguageDefinition>;

export type Language = keyof typeof LANGUAGES;

// ─── Stack categories ────────────────────────────────────────────────────────

export type StackCategory = "frontend" | "backend" | "fullstack" | "static" | "docker" | "services" | "generic";

// ─── Project type (determines deploy-page UI path) ──────────────────────────

export type ProjectType = "app" | "docker" | "services";

// ─── Stack definition ────────────────────────────────────────────────────────

/**
 * Detection inputs for a stack. Used by both `detectStack` (which framework is this?)
 * and `project-root-detector` (where in the tree is a deployable project?).
 *
 * Keep this declarative — every stack adds exactly one entry here, and both the
 * framework-rule list and the root-marker set derive from it. If you find yourself
 * adding fileMatch/depMatch overrides in `stack-detector.ts`, that's a sign the
 * stack has irregular detection (e.g. negations or conjunctions) — fine, but
 * `rootMarkers` here must still list the project-root signals.
 */
export interface StackDetection {
  /**
   * Files whose presence at a directory marks that directory as a candidate
   * project root for this stack. Lowercased basenames; nested-path markers
   * (e.g. "config/routes.rb") are also accepted and matched verbatim.
   */
  rootMarkers?: readonly string[];
  /**
   * Dependency names (from package.json / requirements.txt / go.mod / Cargo.toml /
   * Gemfile / composer.json / mix.exs) whose presence implies this stack.
   */
  deps?: readonly string[];
  /**
   * Filename → regex source pairs. If the file content matches, the stack is
   * implied. Used when a stack can't be discriminated by deps alone
   * (e.g. Spring Boot in build.gradle).
   */
  contentPatterns?: Readonly<Record<string, string>>;
}

export interface StackDefinition {
  /** Human-readable display name */
  name: string;
  /** Programming language */
  language: Language;
  /** Category */
  category: StackCategory;
  /** Docker image for builds (overrides the language default) */
  buildImage?: string;
  /** Docker image for production runtime (overrides the language default) */
  runtimeImage?: string;
  /** Default output directory after build */
  outputDirectory: string;
  /** Default port the application listens on */
  defaultPort: number;
  /** Default build command when project has none */
  defaultBuildCommand: string;
  /** Default start command */
  defaultStartCommand: string;
  /** Minimum tool versions required by this stack on bare metal. */
  requiredToolVersions?: Readonly<Record<string, string>>;
  /**
   * Files/directories to copy into `/app/production/` after build.
   * Only these paths are needed at runtime — everything else stays in `/app`.
   * Omit for stacks where everything is needed (e.g. docker, static).
   */
  productionPaths?: readonly string[];
  /**
   * Directories created during build that can be excluded from transfer.
   * Only framework-specific caches — generic ones (.git) are always excluded.
   */
  cacheDirs?: readonly string[];
  /**
   * Preferred build location for this stack.
   * "server" = build in the cloud/workspace (default if omitted).
   * "local"  = build on the host machine, then transfer the artifact.
   */
  defaultBuildStrategy?: "server" | "local";
  /**
   * Detection signals — files / deps / content patterns. Consumed by
   * `stack-detector.ts` and `project-root-detector.ts`. See {@link StackDetection}.
   */
  detection?: StackDetection;
}

// ─── The registry ────────────────────────────────────────────────────────────

export const STACKS = {

  // ── JavaScript / TypeScript — Frontend & Fullstack ─────────────────────────

  nextjs: {
    name: "Next.js",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".next",
    defaultPort: 3000,
    defaultBuildCommand: "next build",
    defaultStartCommand: "next start",
    requiredToolVersions: { node: "20.9.0" },
    cacheDirs: [".next/cache"],
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["next.config.js", "next.config.mjs", "next.config.ts"],
      deps: ["next"],
    },
  },
  nuxt: {
    name: "Nuxt",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".output",
    defaultPort: 3000,
    defaultBuildCommand: "nuxt build",
    defaultStartCommand: "node .output/server/index.mjs",
    cacheDirs: [".nuxt"],
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["nuxt.config.js", "nuxt.config.ts", "nuxt.config.mjs"],
      deps: ["nuxt", "@nuxt/core"],
    },
  },
  sveltekit: {
    name: "SvelteKit",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".svelte-kit",
    defaultPort: 3000,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "node build/index.js",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["svelte.config.js", "svelte.config.mjs"],
      deps: ["svelte", "@sveltejs/kit"],
    },
  },
  remix: {
    name: "Remix",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "remix build",
    defaultStartCommand: "remix-serve build/index.js",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["remix.config.js", "remix.config.ts"],
      deps: ["@remix-run/react", "@remix-run/node", "remix"],
    },
  },
  astro: {
    name: "Astro",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4321,
    defaultBuildCommand: "astro build",
    defaultStartCommand: "node dist/server/entry.mjs",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["astro.config.mjs", "astro.config.js", "astro.config.ts"],
      deps: ["astro"],
    },
  },
  vite: {
    name: "Vite",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 5173,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["vite.config.js", "vite.config.ts", "vite.config.mjs"],
      deps: ["vite"],
    },
  },
  angular: {
    name: "Angular",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4200,
    defaultBuildCommand: "ng build --configuration production",
    defaultStartCommand: "",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["angular.json"],
      deps: ["@angular/core"],
    },
  },
  gatsby: {
    name: "Gatsby",
    language: "javascript",
    category: "frontend",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "gatsby build",
    defaultStartCommand: "gatsby serve",
    cacheDirs: [".cache"],
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["gatsby-config.js", "gatsby-config.ts"],
      deps: ["gatsby"],
    },
  },
  cra: {
    name: "Create React App",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "react-scripts build",
    defaultStartCommand: "",
    defaultBuildStrategy: "local",
    detection: {
      // CRA's only durable signal is the react-scripts dep; the public+src
      // layout is shared with many other React setups.
      deps: ["react-scripts"],
    },
  },
  vue: {
    name: "Vue CLI",
    language: "javascript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 8080,
    defaultBuildCommand: "vue-cli-service build",
    defaultStartCommand: "",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["vue.config.js", "vue.config.ts"],
      // Note: deps gate is the disambiguator vs. Nuxt — checked in stack-detector.
      deps: ["vue"],
    },
  },
  react: {
    name: "React",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    defaultBuildStrategy: "local",
  },

  // ── JavaScript / TypeScript — Backend ──────────────────────────────────────

  express: {
    name: "Express",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",
    defaultBuildStrategy: "local",
    detection: {
      deps: ["express"],
    },
  },
  fastify: {
    name: "Fastify",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",
    defaultBuildStrategy: "local",
    detection: {
      deps: ["fastify"],
    },
  },
  hono: {
    name: "Hono",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",
    defaultBuildStrategy: "local",
    detection: {
      deps: ["hono"],
    },
  },
  nestjs: {
    name: "NestJS",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "nest build",
    defaultStartCommand: "node dist/main.js",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["nest-cli.json"],
      deps: ["@nestjs/core"],
    },
  },
  koa: {
    name: "Koa",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",
    defaultBuildStrategy: "local",
    detection: {
      deps: ["koa"],
    },
  },
  adonis: {
    name: "AdonisJS",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3333,
    defaultBuildCommand: "node ace build --production",
    defaultStartCommand: "node build/server.js",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["ace.js", ".adonisrc.json", "adonisrc.ts"],
      deps: ["@adonisjs/core"],
    },
  },
  elysia: {
    name: "Elysia",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "bun dist/index.js",
    defaultBuildStrategy: "local",
    detection: {
      deps: ["elysia"],
    },
  },

  // ── Go ─────────────────────────────────────────────────────────────────────

  go: {
    name: "Go",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
    },
  },
  gin: {
    name: "Gin",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/gin-gonic/gin"],
    },
  },
  fiber: {
    name: "Fiber",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/gofiber/fiber"],
    },
  },
  echo: {
    name: "Echo",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/labstack/echo"],
    },
  },

  // ── Rust ───────────────────────────────────────────────────────────────────

  rust: {
    name: "Rust",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8080,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
    },
  },
  actix: {
    name: "Actix Web",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8080,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["actix-web"],
    },
  },
  axum: {
    name: "Axum",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 3000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["axum"],
    },
  },
  rocket: {
    name: "Rocket",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["rocket"],
    },
  },

  // ── Python ─────────────────────────────────────────────────────────────────

  python: {
    name: "Python",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "python app.py",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"],
    },
  },
  django: {
    name: "Django",
    language: "python",
    category: "fullstack",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt && python manage.py collectstatic --noinput",
    defaultStartCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:8000",
    detection: {
      rootMarkers: ["manage.py"],
    },
  },
  flask: {
    name: "Flask",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 5000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "gunicorn app:app --bind 0.0.0.0:5000",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile"],
      deps: ["flask", "Flask"],
    },
  },
  fastapi: {
    name: "FastAPI",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile"],
      deps: ["fastapi", "FastAPI"],
    },
  },

  // ── Ruby ───────────────────────────────────────────────────────────────────

  rails: {
    name: "Ruby on Rails",
    language: "ruby",
    category: "fullstack",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "bundle install && bundle exec rails assets:precompile",
    defaultStartCommand: "bundle exec rails server -b 0.0.0.0",
    detection: {
      // Rails: Gemfile is required; bin/rails or config/routes.rb confirms.
      // The conjunction is encoded as an override in stack-detector.
      rootMarkers: ["Gemfile", "bin/rails", "config/routes.rb"],
    },
  },
  sinatra: {
    name: "Sinatra",
    language: "ruby",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 4567,
    defaultBuildCommand: "bundle install",
    defaultStartCommand: "ruby app.rb",
    detection: {
      rootMarkers: ["Gemfile"],
      deps: ["sinatra"],
    },
  },

  // ── PHP ────────────────────────────────────────────────────────────────────

  laravel: {
    name: "Laravel",
    language: "php",
    category: "fullstack",
    runtimeImage: "php:8.3-apache",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "composer install --no-dev --optimize-autoloader",
    defaultStartCommand: "php artisan serve --host=0.0.0.0 --port=8000",
    detection: {
      rootMarkers: ["artisan", "composer.json"],
      deps: ["laravel/framework"],
    },
  },
  symfony: {
    name: "Symfony",
    language: "php",
    category: "fullstack",
    runtimeImage: "php:8.3-apache",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "composer install --no-dev --optimize-autoloader",
    defaultStartCommand: "php -S 0.0.0.0:8000 -t public",
    detection: {
      rootMarkers: ["composer.json", "symfony.lock"],
      deps: ["symfony/framework-bundle"],
    },
  },

  // ── Java / JVM ─────────────────────────────────────────────────────────────

  springboot: {
    name: "Spring Boot",
    language: "java",
    category: "backend",
    outputDirectory: "target",
    defaultPort: 8080,
    defaultBuildCommand: "mvn clean package -DskipTests",
    defaultStartCommand: "java -jar target/*.jar",
    productionPaths: ["target"],
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
      deps: ["org.springframework.boot:spring-boot-starter-web", "spring-boot"],
      contentPatterns: {
        "pom.xml": "spring[-.]boot",
        "build.gradle": "spring[-.]boot",
        "build.gradle.kts": "spring[-.]boot",
      },
    },
  },
  quarkus: {
    name: "Quarkus",
    language: "java",
    category: "backend",
    outputDirectory: "target",
    defaultPort: 8080,
    defaultBuildCommand: "mvn clean package -DskipTests",
    defaultStartCommand: "java -jar target/quarkus-app/quarkus-run.jar",
    productionPaths: ["target"],
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
      deps: ["io.quarkus:quarkus-core", "quarkus"],
      contentPatterns: {
        "pom.xml": "io\\.quarkus",
        "build.gradle": "io\\.quarkus",
        "build.gradle.kts": "io\\.quarkus",
      },
    },
  },

  // ── C# / .NET ──────────────────────────────────────────────────────────────

  dotnet: {
    name: ".NET",
    language: "csharp",
    category: "backend",
    outputDirectory: "bin/Release/net8.0/publish",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    defaultStartCommand: "dotnet publish/app.dll",
    productionPaths: ["publish"],
    detection: {
      // .csproj/.fsproj/.sln are detected by suffix; rootMarkers is decorative
      // here since the suffix-match lives in stack-detector.
    },
  },
  blazor: {
    name: "Blazor",
    language: "csharp",
    category: "fullstack",
    outputDirectory: "bin/Release/net8.0/publish/wwwroot",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    defaultStartCommand: "dotnet publish/app.dll",
    productionPaths: ["publish"],
    detection: {
      deps: ["Microsoft.AspNetCore.Components.WebAssembly"],
    },
  },

  // ── Elixir ─────────────────────────────────────────────────────────────────

  phoenix: {
    name: "Phoenix",
    language: "elixir",
    category: "fullstack",
    outputDirectory: "_build/prod/rel",
    defaultPort: 4000,
    defaultBuildCommand: "MIX_ENV=prod mix do deps.get, compile, assets.deploy, release",
    defaultStartCommand: "_build/prod/rel/app/bin/app start",
    productionPaths: ["_build/prod/rel"],
    detection: {
      rootMarkers: ["mix.exs"],
      deps: ["phoenix"],
    },
  },

  // ── Generic ────────────────────────────────────────────────────────────────

  node: {
    name: "Node.js",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["package.json"],
    },
  },
  static: {
    name: "Static Site",
    language: "multi",
    category: "static",
    buildImage: "node:22",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    defaultBuildStrategy: "local",
    detection: {
      rootMarkers: ["index.html"],
    },
  },
  docker: {
    name: "Dockerfile",
    language: "multi",
    category: "docker",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    detection: {
      rootMarkers: ["Dockerfile"],
    },
  },
  "docker-compose": {
    name: "Docker Compose",
    language: "multi",
    category: "services",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    detection: {
      rootMarkers: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
    },
  },
  unknown: {
    name: "Unknown",
    language: "multi",
    category: "generic",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
  },
} as const satisfies Record<string, StackDefinition>;

// ─── Derived constants (auto-generated, never edit manually) ─────────────────

/** All stack IDs as a type — replaces the old hardcoded `Framework` union */
export type StackId = keyof typeof STACKS;

/** All stack IDs as a runtime array */
export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** All language IDs as a runtime array */
export const LANGUAGE_IDS = Object.keys(LANGUAGES) as Language[];

/** All unique package managers across all languages */
export const ALL_PACKAGE_MANAGERS: string[] = [
  ...new Set(Object.values(LANGUAGES).flatMap((l) => l.packageManagers)),
];

/**
 * Paths always excluded when transferring project files (source or build output).
 * Framework-specific caches (e.g. `.next/cache`) are defined per-stack via `cacheDirs`.
 */
export const TRANSFER_EXCLUDES: readonly string[] = ["node_modules", ".git", ".turbo"];

/** Output directories keyed by stack — derived from STACKS */
export const OUTPUT_DIRECTORIES: Record<string, string> = Object.fromEntries(
  Object.entries(STACKS).map(([id, s]) => [id, s.outputDirectory]),
);

/**
 * Every filename that any stack uses as a project-root marker, lowercased.
 * Project-root-detector unions this with workspace/build-tool markers to discover
 * candidate roots in a repo tree. Adding a stack with `detection.rootMarkers`
 * automatically flows here — no parallel list to maintain.
 */
export const STACK_ROOT_MARKERS: ReadonlySet<string> = new Set(
  Object.values(STACKS)
    .flatMap((stack) => (stack as StackDefinition).detection?.rootMarkers ?? [])
    .map((marker) => marker.toLowerCase()),
);

/** JS/TS languages that should use oven/bun when the package manager is bun */
const BUN_ELIGIBLE_LANGUAGES: ReadonlySet<string> = new Set(["javascript", "typescript"]);

/** Get the resolved Docker build image for a stack */
export function getBuildImage(stackId: StackId, packageManager?: string): string {
  const stack = STACKS[stackId] as StackDefinition;
  if (packageManager === "bun" && BUN_ELIGIBLE_LANGUAGES.has(stack.language)) {
    return "oven/bun:latest";
  }
  return stack.buildImage ?? LANGUAGES[stack.language].buildImage;
}

/** Get the resolved Docker runtime image for a stack */
export function getRuntimeImage(stackId: StackId, packageManager?: string): string {
  const stack = STACKS[stackId] as StackDefinition;
  if (packageManager === "bun" && BUN_ELIGIBLE_LANGUAGES.has(stack.language)) {
    return "oven/bun:latest";
  }
  return stack.runtimeImage ?? LANGUAGES[stack.language].runtimeImage;
}


/** Get the full stack definition with resolved images */
export function getStackDefaults(stackId: StackId, packageManager?: string) {
  const stack = STACKS[stackId] as StackDefinition;
  return {
    ...stack,
    buildImage: getBuildImage(stackId, packageManager),
    runtimeImage: getRuntimeImage(stackId, packageManager),
  };
}

/** Derive the project type from a stack ID */
export function getProjectType(stackId: StackId): ProjectType {
  const cat = (STACKS[stackId] as StackDefinition).category;
  if (cat === "docker") return "docker";
  if (cat === "services") return "services";
  return "app";
}

/**
 * Hint whether a stack is typically static (no running server).
 * Used as a default for the hasServer toggle — the user can override.
 */
export function isTypicallyStatic(stackId: StackId): boolean {
  const stack = STACKS[stackId] as StackDefinition;
  return (
    (stack.category === "static" || stack.category === "frontend") &&
    !stack.defaultStartCommand
  );
}

// ─── Icon URLs — source of truth for logo/icon display ───────────────────────

const DI = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";

export const STACK_ICONS: Partial<Record<StackId, string>> = {
  // JS/TS — Frontend & Fullstack
  nextjs:      `${DI}/nextjs/nextjs-original.svg`,
  nuxt:        `${DI}/nuxtjs/nuxtjs-original.svg`,
  sveltekit:   `${DI}/svelte/svelte-original.svg`,
  remix:       `${DI}/react/react-original.svg`,
  astro:       `${DI}/astro/astro-original.svg`,
  vite:        `${DI}/vitejs/vitejs-original.svg`,
  angular:     `${DI}/angular/angular-original.svg`,
  gatsby:      `${DI}/gatsby/gatsby-original.svg`,
  cra:         `${DI}/react/react-original.svg`,
  vue:         `${DI}/vuejs/vuejs-original.svg`,
  react:       `${DI}/react/react-original.svg`,

  // JS/TS — Backend
  express:     `${DI}/express/express-original.svg`,
  fastify:     `${DI}/fastify/fastify-original.svg`,
  hono:        "https://hono.dev/images/logo-small.png",
  nestjs:      `${DI}/nestjs/nestjs-original.svg`,
  koa:         `${DI}/nodejs/nodejs-original.svg`,
  adonis:      `${DI}/adonisjs/adonisjs-original.svg`,
  elysia:      "https://elysiajs.com/assets/elysia.svg",

  // Go
  go:          `${DI}/go/go-original.svg`,
  gin:         `${DI}/go/go-original.svg`,
  fiber:       `${DI}/go/go-original.svg`,
  echo:        `${DI}/go/go-original.svg`,

  // Rust
  rust:        `${DI}/rust/rust-original.svg`,
  actix:       `${DI}/rust/rust-original.svg`,
  axum:        `${DI}/rust/rust-original.svg`,
  rocket:      `${DI}/rust/rust-original.svg`,

  // Python
  python:      `${DI}/python/python-original.svg`,
  django:      `${DI}/django/django-plain.svg`,
  flask:       `${DI}/flask/flask-original.svg`,
  fastapi:     `${DI}/fastapi/fastapi-original.svg`,

  // Ruby
  rails:       `${DI}/rails/rails-plain.svg`,
  sinatra:     `${DI}/ruby/ruby-original.svg`,

  // PHP
  laravel:     `${DI}/laravel/laravel-original.svg`,
  symfony:     `${DI}/symfony/symfony-original.svg`,

  // Java
  springboot:  `${DI}/spring/spring-original.svg`,
  quarkus:     `${DI}/quarkus/quarkus-original.svg`,

  // C# / .NET
  dotnet:      `${DI}/dotnetcore/dotnetcore-original.svg`,
  blazor:      `${DI}/dotnetcore/dotnetcore-original.svg`,

  // Elixir
  phoenix:     `${DI}/phoenix/phoenix-original.svg`,

  // Generic
  node:        `${DI}/nodejs/nodejs-original.svg`,
  static:      `${DI}/html5/html5-original.svg`,
  docker:      `${DI}/docker/docker-original.svg`,
  "docker-compose": `${DI}/docker/docker-original.svg`,
};
