const express = require('express')
const path = require('path')
const puppeteer = require('puppeteer')

const app = express()
app.use(express.json())

let browser

async function initBrowser() {
  // ⬇️ 启用 GPU 并关闭沙箱（绕过 WebGL 初始化失败）
  browser = await puppeteer.launch({
    //headless: true,
    headless: false,    // 显示浏览器窗口
    devtools: true,     // 自动打开 DevTools
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
  })

  console.log('✅ Puppeteer 浏览器已启动')
}

// 挂载整个 Cesium 构建目录为静态资源
app.use('/cesium', express.static(path.resolve(__dirname, 'node_modules/cesium/Build/Cesium')))

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

// 修改后的 checkCollision 函数
async function checkCollision(lon, lat, height) {

  const page = await browser.newPage();

  // 监听浏览器控制台输出
  page.on('console', async (msg) => {
    const args = await Promise.all(msg.args().map(arg => arg.jsonValue().catch(() => arg.toString())));
    console.log(`[Browser Log]: ${msg.text()}`, ...args);
  });

  console.log(`🚀 检测位置: 经度=${lon}, 纬度=${lat}, 高度=${height}`);

  // 启用必要的浏览器功能
  await page.setBypassCSP(true); // 关键：绕过 CSP 限制
  await page.setViewport({ width: 1920, height: 1080 });

  // 直接访问配置好的 Cesium 页面
  await page.goto(`http://localhost:${PORT}/cesium.html`, {
    waitUntil: 'networkidle0',
    timeout: 60000
  });

  // 验证 Cesium 加载
  try {
    await page.waitForFunction(
      'typeof Cesium !== "undefined" && Cesium.Viewer',
      { timeout: 10000 }
    );
  } catch (e) {
    const content = await page.content();
    console.error('页面内容:', content.slice(0, 500));
    throw new Error('Cesium 加载失败: ' + e.message);
  }

  // 执行检测逻辑
  return page.evaluate(async (lon, lat, height) => {
    try {
      //debugger; // 触发断点，便于调试
      // const viewer = new Cesium.Viewer('cesiumContainer', {
      //   terrain: Cesium.Terrain.fromWorldTerrain(),
      //   //新增代码
      //   requestWaterMask: true,
      //   shouldRender: false,
      //   baseLayerPicker: false,
      //   navigationHelpButton: false,
      //   // 禁用所有不必要的控件
      //   timeline: false,
      //   animation: false,
      //   sceneModePicker: false,
      //   selectionIndicator: false,
      //   infoBox: false
      // });

      // 替换为以下代码 👇
      const viewer = new Cesium.Viewer('cesiumContainer', {
        terrain: undefined, // 明确关闭地形
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

      viewer.scene.primitives.add(tileset);

      await tileset.readyPromise;

      console.log("✅ 3D Tiles 模型加载完成");

      // 更可靠的地形加载检测
      // await new Promise((resolve) => {
      //   viewer.scene.globe.tileLoadProgressEvent.addEventListener((remaining) => {
      //     if (remaining === 0) resolve();
      //   });
      //   setTimeout(resolve, 20000); // 超时回退
      // });

      // 🔥 等待地形加载完成
      await new Promise((resolve, reject) => {
        let timeout = setTimeout(() => {
          clearTimeout(timeout);
          reject(new Error('地形加载超时'));
        }, 20000); // 20秒超时

        viewer.scene.globe.tileLoadProgressEvent.addEventListener((remaining) => {
          if (remaining === 0) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      console.log('✅ Cesium 加载完成');


      const position = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      const ray = new Cesium.Ray(
        position,
        Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3())
      );

      const modelIntersection = viewer.scene.pickFromRay(ray);
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
initBrowser().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Collision detection API running at http://localhost:${PORT}`)
  })
})