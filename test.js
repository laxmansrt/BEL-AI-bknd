const fs = require('fs');
async function run() {
  const b64 = "data:image/jpeg;base64," + Buffer.from("test image data").toString('base64');
  console.log("Sending...");
  const res = await fetch("http://localhost:4001/api/disease", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: b64 }),
  });
  console.log(await res.text());
}
run();

