const express = require('express')
const path = require('path')
const puppeteer = require('puppeteer')

const app = express()
app.use(express.json())

// 挂载整个 Cesium 构建目录为静态资源
app.use('/cesium', express.static(path.resolve(__dirname, 'node_modules/cesium/Build/Cesium')));

// 提供 HTML 页面用于加载 Cesium
// 修改后的 /cesium.html 路由（添加 CSP 豁免和完整 Cesium 环境）
app.get('/cesium.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:;">
        <link href="/cesium/Widgets/widgets.css" rel="stylesheet">
        <script src="/cesium/Cesium.js"></script>
        <style>
          html, body, #cesiumContainer { width: 100%; height: 100%; margin: 0; padding: 0; }
        </style>
      </head>
      <body>
        <div id="cesiumContainer"></div>
        <script>
          // 预初始化验证
          console.log('Cesium version:', Cesium.VERSION);
        </script>
      </body>
    </html>
  `);
});


let browser
let page  // ⬅️ 关键：全局Page

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: false,
    devtools: true,
    args: [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu-compositing',
      '--window-size=1920,1080'
    ],
    ignoreDefaultArgs: ['--disable-gpu']
  });

  page = await browser.newPage();
  page.on('console', async (msg) => {
    const args = await Promise.all(msg.args().map(arg => arg.jsonValue().catch(() => arg.toString())));
    console.log(`[Browser Log]: ${msg.text()}`, ...args);

  });
  // 设置浏览器为不受内容安全策略（CSP）限制
  // 这对于加载Cesium的脚本和资源是必要的
  // 注意：在生产环境中请谨慎使用，可能会引入安全风险
  await page.setBypassCSP(true);
  await page.setViewport({ width: 1920, height: 1080 });


  await page.goto(`http://localhost:${PORT}/cesium.html`, { waitUntil: 'networkidle0', timeout: 60000 });

  await page.waitForFunction('typeof Cesium !== "undefined" && Cesium.Viewer', { timeout: 100000 });

  // 只初始化一次模型
  await page.evaluate(async () => {
    window.viewer = new Cesium.Viewer('cesiumContainer', {
      terrain: undefined,
      baseLayerPicker: false,
      shouldRender: true,
      navigationHelpButton: false,
      timeline: false,
      animation: false,
      sceneModePicker: false,
      selectionIndicator: false,
      infoBox: false
    });

    const tileset = await Cesium.Cesium3DTileset.fromUrl(
      "http://localhost:5173/assets/xiaoshan_3dtiles/tileset.json", {
      debugShowBoundingVolume: true,
      dynamicScreenSpaceError: true,
      maximumMemoryUsage: 512
    }
    );

    window.viewer.scene.primitives.add(tileset);
    await tileset.readyPromise;

    window.tileset = tileset; // 存到全局window，后续复用

    await new Promise((resolve, reject) => {
      let timeout = setTimeout(() => {
        clearTimeout(timeout);
        reject(new Error('Tileset加载超时'));
      }, 20000);
      window.viewer.scene.globe.tileLoadProgressEvent.addEventListener((remaining) => {
        if (remaining === 0) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    console.log('✅ Cesium及Tileset初始化完成');
  });

  console.log('✅ Puppeteer 和 Cesium 初始化完成');
}

async function checkCollision(lon, lat, height) {
  console.log(`🚀 检测位置: 经度=${lon}, 纬度=${lat}, 高度=${height}`);

  const result = await page.evaluate(async (lon, lat, height) => {
    try {
      const position = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      const ray = new Cesium.Ray(
        position,
        Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3())
      );

      const modelIntersection = window.viewer.scene.pickFromRay(ray);
      let result = {
        collision: false,
        terrainHeight: null
      };

      if (modelIntersection && modelIntersection.distance !== undefined) {
        const hitPoint = Cesium.Ray.getPoint(ray, modelIntersection.distance);
        const cartographic = Cesium.Cartographic.fromCartesian(hitPoint);
        result = {
          collision: true,
          terrainHeight: cartographic.height
        };
        console.log("✅ 命中模型，高度为:", cartographic.height);
      } else {
        console.log("❌ 未命中模型");
      }

      return result;
    } catch (e) {
      console.error('Cesium 内部错误:', e);
      throw e;
    }
  }, lon, lat, height);

  return result;
}

// HTTP 接口
app.post('/api/check-collision', async (req, res) => {
  const { longitude, latitude, height } = req.body

  if (typeof longitude !== 'number' || typeof latitude !== 'number' || typeof height !== 'number') {
    return res.status(400).json({ error: 'Invalid input' })
  }

  try {
    const result = await checkCollision(longitude, latitude, height)
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// 启动服务
const PORT = process.env.PORT || 3000
// 启动服务
app.listen(PORT, async () => {
  console.log(`🚀 API Server running at http://localhost:${PORT}`);

  // 等服务器启动后再初始化浏览器
  await initBrowser();
});