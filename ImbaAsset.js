const {Asset} = require('parcel-bundler');
const localRequire = require('parcel-bundler/src/utils/localRequire');
const md5 = require('parcel-bundler/src/utils/md5');
const {minify} = require('terser');
const deindent = require('de-indent');
const STYLE_REGEX = /(?<=\n|^)(stylus|less|s?css|sass)(?:.*\n)([\s\S]*?)(\n(?=\S)|$)/g;

class ImbaAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'js';
  }

  async parse(code) {
    await localRequire('imba', this.name);
    var imba = require('imba/lib/compiler');
    var styles = [];

    code = code.replace(STYLE_REGEX, function (...match) {
      var filler;
      filler = code.slice(0, match[3]).replace(/[^\n]/g, '');
      styles.push({
        lang: match[1],
        content: deindent(filler + match[2]),
        map: {} // should we do our own sourceMap?
      });
      return match[0].replace(/[^\n]/g, '');
    }).replace(/\s+$/g, '') + '\n';

    var transpiled = imba.compile(code, {
      filename: this.basename,
      sourceMap: this.options.sourceMaps,
      sourcePath: this.relativeName,
      target: 'web',
      comments: false
    });

    return {
      template: null,
      script: {
        lang: 'js',
        content: transpiled.js,
        map: transpiled.sourcemap
      },
      styles: styles
    };
  }

  async generate() {
    let descriptor = this.ast;
    let parts = [];

    if (descriptor.script) {
      parts.push({
        type: descriptor.script.lang || 'js',
        value: descriptor.script.content,
        sourceMap: descriptor.script.map
      });
    }

    if (descriptor.styles) {
      for (let style of descriptor.styles) {
        parts.push({
          type: style.lang || 'css',
          value: style.content.trim(),
          modules: !!style.module
        });
      }
    }

    return parts;
  }

  async postProcess(generated) {
    let result = [];

    let hasScoped = this.ast.styles.some(s => s.scoped);
    let id = md5(this.name).slice(-6);
    let scopeId = hasScoped ? `data-v-${id}` : null;
    let optsVar = '$' + id;

    // Generate JS output.
    let js = this.ast.script ? generated[0].value : '';
    let supplemental = '';

    // TODO: make it possible to process this code with the normal scope hoister
    if (this.options.scopeHoist) {
      optsVar = `$${this.id}$export$default`;

      if (!js.includes(optsVar)) {
        optsVar = `$${this.id}$exports`;
        if (!js.includes(optsVar)) {
          supplemental += `
            var ${optsVar} = {};
          `;

          this.cacheData.isCommonJS = true;
        }
      }
    } else {
      supplemental += `
        var ${optsVar} = exports.default || module.exports;
      `;
    }

    supplemental += `
      if (typeof ${optsVar} === 'function') {
        ${optsVar} = ${optsVar}.options;
      }
    `;

    supplemental += this.compileCSSModules(generated, optsVar);
    supplemental += this.compileHMR(generated, optsVar);

    if (this.options.minify && !this.options.scopeHoist) {
      let {code, error} = minify(supplemental, {toplevel: true});
      if (error) {
        throw error;
      }

      supplemental = code;
      if (supplemental) {
        supplemental = `\n(function(){${supplemental}})();`;
      }
    }
    js += supplemental;

    if (js) {
      result.push({
        type: 'js',
        value: js
      });
    }

    let map = generated.find(r => r.type === 'map');
    if (map) {
      result.push(map);
    }

    let css = this.compileStyle(generated, scopeId);
    if (css) {
      result.push({
        type: 'css',
        value: css
      });
    }

    return result;
  }

  compileCSSModules(generated, optsVar) {
    let cssRenditions = generated.filter(r => r.type === 'css');
    let cssModulesCode = '';
    this.ast.styles.forEach((style, index) => {
      if (style.module) {
        let cssModules = JSON.stringify(cssRenditions[index].cssModules);
        let name = style.module === true ? '$style' : style.module;
        cssModulesCode += `\nthis[${JSON.stringify(name)}] = ${cssModules};`;
      }
    });

    if (cssModulesCode) {
      cssModulesCode = `function hook(){${cssModulesCode}\n}`;

      return `
        /* css modules */
        (function () {
          ${cssModulesCode}
          ${optsVar}.beforeCreate = ${optsVar}.beforeCreate ? ${optsVar}.beforeCreate.concat(hook) : [hook];
        })();
      `;
    }

    return '';
  }

  compileStyle(generated, scopeId) {
    return generated.filter(r => r.type === 'css').reduce((p, r, i) => {
      let css = r.value;
      let scoped = this.ast.styles[i].scoped;

      // Process scoped styles if needed.
      if (scoped) {
        let {code, errors} = this.vue.compileStyle({
          source: css,
          filename: this.relativeName,
          id: scopeId,
          scoped
        });

        if (errors.length) {
          throw errors[0];
        }

        css = code;
      }

      return p + css;
    }, '');
  }

  compileHMR(generated, optsVar) {
    if (!this.options.hmr) {
      return '';
    }

    this.addDependency('vue-hot-reload-api');

    let cssHMR = '';
    if (this.ast.styles.length) {
      cssHMR = `
        var reloadCSS = require('_css_loader');
        module.hot.dispose(reloadCSS);
        module.hot.accept(reloadCSS);
      `;
    }

    return `
    /* hot reload */
    (function () {
      if (module.hot) {
        var api = require('vue-hot-reload-api');
        if (api.compatible) {
          module.hot.accept();
          if (!module.hot.data) {
            api.createRecord('${optsVar}', ${optsVar});
          } else {
            api.reload('${optsVar}', ${optsVar});
          }
        }

        ${cssHMR}
      }
    })();`;
  }
}

module.exports = ImbaAsset;
