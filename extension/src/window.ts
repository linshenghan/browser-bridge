export {};
const params = new URLSearchParams(location.search);
const name = params.get("name") || "网页任务";
document.title = name + " · Chrome 操作助手";
document.getElementById("name")!.textContent = name;
document.getElementById("identity")!.textContent = "任务编号：" + (params.get("session") || "");
