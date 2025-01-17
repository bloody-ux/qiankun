/**
 * @author Kuitos
 * @since 2020-10-13
 */

import { Freer } from '../../../interfaces';
import { documentAttachProxyMap } from '../../common';
import {
  ContainerConfig,
  isHijackingTag,
  patchHTMLDynamicAppendPrototypeFunctions,
  rawHeadAppendChild,
  rebuildCSSRules,
  recordStyledComponentsCSSRules,
} from './common';

const rawDocumentCreateElement = Document.prototype.createElement;
const proxyAttachContainerConfigMap = new WeakMap<WindowProxy, ContainerConfig>();

const elementAttachContainerConfigMap = new WeakMap<HTMLElement, ContainerConfig>();
function patchDocumentCreateElement() {
  if (Document.prototype.createElement === rawDocumentCreateElement) {
    Document.prototype.createElement = function createElement<K extends keyof HTMLElementTagNameMap>(
      this: Document,
      tagName: K,
      options?: ElementCreationOptions,
    ): HTMLElement {
      const element = rawDocumentCreateElement.call(this, tagName, options);
      if (isHijackingTag(tagName)) {
        // 这里使用document来获取比this更加健壮，因为之前set的时候是传入的document：
        // 因为document不一定是原生的document，这种情况出现在qiankun本身就在另一个沙箱下运行的情况，而那个沙箱可能连document都重写了。
        const attachProxy = documentAttachProxyMap.get(document);
        if (attachProxy) {
          const proxyContainerConfig = proxyAttachContainerConfigMap.get(attachProxy);
          if (proxyContainerConfig) {
            elementAttachContainerConfigMap.set(element, proxyContainerConfig);
          }
        }
      }

      return element;
    };
  }

  return function unpatch() {
    Document.prototype.createElement = rawDocumentCreateElement;
  };
}

let bootstrappingPatchCount = 0;
let mountingPatchCount = 0;

export function patchStrictSandbox(
  appName: string,
  appWrapperGetter: () => HTMLElement | ShadowRoot,
  proxy: Window,
  mounting = true,
  scopedCSS = false,
  excludeAssetFilter?: CallableFunction,
): Freer {
  let containerConfig = proxyAttachContainerConfigMap.get(proxy);
  if (!containerConfig) {
    containerConfig = {
      appName,
      proxy,
      appWrapperGetter,
      dynamicStyleSheetElements: [],
      strictGlobal: true,
      excludeAssetFilter,
      scopedCSS,
    };
    proxyAttachContainerConfigMap.set(proxy, containerConfig);
  }
  // all dynamic style sheets are stored in proxy container
  const { dynamicStyleSheetElements } = containerConfig;

  const unpatchDocumentCreate = patchDocumentCreateElement();

  const unpatchDynamicAppendPrototypeFunctions = patchHTMLDynamicAppendPrototypeFunctions(
    (element) => elementAttachContainerConfigMap.has(element),
    (element) => elementAttachContainerConfigMap.get(element)!,
  );

  if (!mounting) bootstrappingPatchCount++;
  if (mounting) mountingPatchCount++;

  return function free() {
    // bootstrap patch just called once but its freer will be called multiple times
    if (!mounting && bootstrappingPatchCount !== 0) bootstrappingPatchCount--;
    if (mounting) mountingPatchCount--;

    const allMicroAppUnmounted = mountingPatchCount === 0 && bootstrappingPatchCount === 0;
    // release the overwrite prototype after all the micro apps unmounted
    if (allMicroAppUnmounted) {
      unpatchDynamicAppendPrototypeFunctions();
      unpatchDocumentCreate();
    }

    proxyAttachContainerConfigMap.delete(proxy);

    recordStyledComponentsCSSRules(dynamicStyleSheetElements);

    // As now the sub app content all wrapped with a special id container,
    // the dynamic style sheet would be removed automatically while unmoutting

    return function rebuild() {
      rebuildCSSRules(dynamicStyleSheetElements, (stylesheetElement) =>
        rawHeadAppendChild.call(appWrapperGetter(), stylesheetElement),
      );
    };
  };
}
