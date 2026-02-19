import { describe, it, expect } from "vitest";
import { bundlerUnpackPass } from "../../src/passes/bundler-unpack.js";
import { parse, generate } from "../../src/parser.js";

function deobfuscate(code: string): string {
  const ast = parse(code);
  const result = bundlerUnpackPass.run(ast);
  return generate(result);
}

describe("bundler unpacking", () => {
  describe("R14: webpack 4 detection", () => {
    it("detects and unpacks webpack 4 array format", () => {
      const result = deobfuscate(`
        (function(modules) {
          var installedModules = {};
          function __webpack_require__(moduleId) {
            if (installedModules[moduleId]) return installedModules[moduleId].exports;
            var module = installedModules[moduleId] = { i: moduleId, l: false, exports: {} };
            modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
            module.l = true;
            return module.exports;
          }
          return __webpack_require__(0);
        })([
          function(module, exports, __webpack_require__) {
            var dep = __webpack_require__(1);
            console.log(dep.hello());
          },
          function(module, exports) {
            exports.hello = function() { return 'world'; };
          }
        ]);
      `);
      // Module bodies extracted
      expect(result).toContain("console.log");
      expect(result).toContain("'world'");
      // Runtime boilerplate removed
      expect(result).not.toContain("installedModules");
    });

    it("detects webpack 4 object format", () => {
      const result = deobfuscate(`
        (function(modules) {
          var installedModules = {};
          function __webpack_require__(moduleId) {
            if (installedModules[moduleId]) return installedModules[moduleId].exports;
            var module = installedModules[moduleId] = { exports: {} };
            modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
            return module.exports;
          }
          return __webpack_require__(0);
        })({
          0: function(module, exports, __webpack_require__) {
            var dep = __webpack_require__(1);
            console.log(dep.greet());
          },
          1: function(module, exports) {
            exports.greet = function() { return 'hi'; };
          }
        });
      `);
      expect(result).toContain("console.log");
      expect(result).toContain("'hi'");
      expect(result).not.toContain("installedModules");
    });
  });

  describe("R14: webpack 5 detection", () => {
    it("detects and unpacks webpack 5 format", () => {
      const result = deobfuscate(`
        (() => {
          var __webpack_modules__ = {
            "./src/utils.js": (module) => {
              module.exports = { name: 'utils' };
            },
            "./src/index.js": (module, __unused, __webpack_require__) => {
              var utils = __webpack_require__("./src/utils.js");
              console.log(utils.name);
            }
          };
          var __webpack_module_cache__ = {};
          function __webpack_require__(moduleId) {
            var cachedModule = __webpack_module_cache__[moduleId];
            if (cachedModule !== undefined) return cachedModule.exports;
            var module = __webpack_module_cache__[moduleId] = { exports: {} };
            __webpack_modules__[moduleId](module, module.exports, __webpack_require__);
            return module.exports;
          }
          var __webpack_exports__ = __webpack_require__("./src/index.js");
        })();
      `);
      expect(result).toContain("console.log");
      expect(result).toContain("'utils'");
      expect(result).not.toContain("__webpack_module_cache__");
    });
  });

  describe("R14: browserify detection", () => {
    it("detects and unpacks browserify bundle", () => {
      const result = deobfuscate(`
        (function(t, n, r) {
          function s(o, u) {
            if (!n[o]) {
              if (!t[o]) {
                var a = typeof require == "function" && require;
                if (!u && a) return a(o, true);
                throw new Error("Cannot find module '" + o + "'");
              }
              var l = n[o] = { exports: {} };
              t[o][0].call(l.exports, function(e) {
                var n = t[o][1][e];
                return s(n ? n : e);
              }, l, l.exports, t, n, r);
            }
            return n[o].exports;
          }
          for (var o = 0; o < r.length; o++) s(r[o]);
          return s;
        })({
          1: [function(require, module, exports) {
            module.exports = 'DEP';
          }, {}],
          2: [function(require, module, exports) {
            var dep = require('./dep');
            console.log(dep);
          }, { "./dep": 1 }]
        }, {}, [2]);
      `);
      expect(result).toContain("console.log");
      expect(result).toContain("'DEP'");
      // Runtime boilerplate removed
      expect(result).not.toContain("typeof require");
    });
  });

  describe("module extraction", () => {
    it("extracts modules as named function declarations", () => {
      const result = deobfuscate(`
        (function(modules) {
          var installedModules = {};
          function __webpack_require__(moduleId) {
            if (installedModules[moduleId]) return installedModules[moduleId].exports;
            var module = installedModules[moduleId] = { exports: {} };
            modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
            return module.exports;
          }
          return __webpack_require__(0);
        })([
          function(module, exports) {
            exports.main = true;
          },
          function(module, exports) {
            exports.dep = true;
          }
        ]);
      `);
      // Each module should be a named function
      expect(result).toContain("__module_0__");
      expect(result).toContain("__module_1__");
      expect(result).toContain("exports.main = true");
      expect(result).toContain("exports.dep = true");
    });
  });

  describe("safety", () => {
    it("does not modify non-bundle code", () => {
      const result = deobfuscate(`
        function add(a, b) { return a + b; }
        console.log(add(1, 2));
      `);
      expect(result).toContain("add");
      expect(result).toContain("return");
    });

    it("does not modify regular IIFEs", () => {
      const result = deobfuscate(`
        (function() {
          var x = 1;
          console.log(x);
        })();
      `);
      expect(result).toContain("var x = 1");
      expect(result).toContain("console.log");
    });

    it("does not modify objects that look like module maps but aren't bundles", () => {
      const result = deobfuscate(`
        var modules = {
          0: function() { return 'a'; },
          1: function() { return 'b'; }
        };
        console.log(modules[0]());
      `);
      expect(result).toContain("modules");
    });
  });
});
