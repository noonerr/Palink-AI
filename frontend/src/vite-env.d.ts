/// <reference types="vite/client" />

// [P1-SHIM-EXTERNAL] Vite 插件提供的虚拟模块：返回外部运行时资产 URL（hash 文件名）。
declare module 'virtual:palink-smart-card-runtime-url' {
  const runtimeUrl: string;
  export default runtimeUrl;
}

declare module 'virtual:pwa-register/react' {
  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: any) => void;
  }
  export function useRegisterSW(options?: RegisterSWOptions): void;
}

// ST 兼容库类型声明（这些包不自带 .d.ts）
declare module 'jquery' {
  const jQuery: any;
  export default jQuery;
}
declare module 'toastr' {
  const toastr: any;
  export default toastr;
}
declare module 'select2' {
  const select2: any;
  export default select2;
}
