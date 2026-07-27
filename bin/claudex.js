#!/usr/bin/env node
// Single-file bundle: this runs before every `claude` invocation, so the entry
// point avoids resolving the full module graph. See scripts/build.mjs.
import { main } from '../dist/cli.bundle.js';

main(process.argv.slice(2));
