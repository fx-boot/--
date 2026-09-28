"use strict";
const api = window.managerAPI;
document.getElementById("windowMin").addEventListener("click", () => api.window.minimize());
for (const id of ["windowClose", "closeInfo"]) {
  document.getElementById(id).addEventListener("click", () => api.window.close());
}
