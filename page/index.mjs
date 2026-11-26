import { Workbench } from "../shared/workbench.mjs";

export async function mount(root, api) {
  root.classList.add("bs-page-host");
  const workbench = new Workbench(root, api, { variant: "page" });
  return await workbench.init();
}
