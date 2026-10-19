// 一键恢复所有本地数据
const cloudData = {
    "version":  "1.0.0",
    "lastSync":  1792113526817,
    "keys": {}
};
Object.entries(cloudData.keys).forEach(([k,v]) => localStorage.setItem(k, v));
alert('数据恢复完成！'); location.reload();
