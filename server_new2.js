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


    // 使用纯 await 语法
    await tileset.readyPromise;
    tileset.loadProgress.addEventListener((numberOfPendingRequests) => {
      console.log(`正在加载: ${numberOfPendingRequests} 个请求`);
    });

    // 定位到 Tileset
    viewer.zoomTo(tileset);

    window.tileset = tileset; // 存到全局window，后续复用

    await new Promise((resolve, reject) => {
      let timeout = setTimeout(() => {
        clearTimeout(timeout);
        reject(new Error('Tileset加载超时'));
      }, 25000);
      window.viewer.scene.globe.tileLoadProgressEvent.addEventListener((remaining) => {
        if (remaining === 0) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    console.log('✅ Cesium及Tileset初始化完成');

    viewer.canvas.addEventListener('click', function (event) {
      const rect = viewer.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      console.log(`Canvas 点击位置: x=${x}, y=${y}`);

      // 创建射线
      const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
      if (!ray) {
        console.log("⚠️ 射线生成失败");
        return;
      }

      // 检测是否命中地形
      const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
      if (!cartesian) {
        console.log("❌ 未命中地形");
        return;
      }

      // 转换为地理坐标（经纬高）
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      const lon = Cesium.Math.toDegrees(cartographic.longitude);
      const lat = Cesium.Math.toDegrees(cartographic.latitude);
      const height = cartographic.height;

      console.log(`地理坐标: 经度=${lon.toFixed(6)}, 纬度=${lat.toFixed(6)}, 高度=${height.toFixed(2)} 米`);
    });
  });

  console.log('✅ Puppeteer 和 Cesium 初始化完成');
}

async function checkCollision(lon, lat, height) {

  console.log(`🚀 检测位置: 经度=${lon}, 纬度=${lat}, 高度=${height}`);

  const result = await page.evaluate(async (lon, lat, height) => {
    try {
      const dronePositionCartesian = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      const cameraDirection = Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3())
      const ray = new Cesium.Ray(
        dronePositionCartesian,
        cameraDirection // 向下发射射线（取反Z轴）
      );

      console.log('射线起点:', ray.origin);

      const cartographic = Cesium.Cartographic.fromCartesian(ray.origin);
      console.log(`射线起点海拔高度: ${height.toFixed(2)} 米`);
      console.log('射线方向:', ray.direction);

      // drillPickFromRay 获取射线穿透的所有物体
      const results = viewer.scene.drillPickFromRay(ray, 10); // 第二个参数限制10个物体
      if (results.length === 0) {
        console.log("❌ 射线未穿过任何建筑物");
        return {
          collision: false,
          terrainHeight: cartographic.height
        };
      }

      let changedCount = 0;
      let cartographicHit = null;
      let distance = 0;
      let hitObjectHeight = 0;

      for (const result of results) {
        //if (result instanceof Cesium.Cesium3DTileFeature) {

        hitObjectHeight = Cesium.Cartographic.fromCartesian(result.position).height;  // 获取建筑物高度属性
        console.log(`建筑物高度: ${hitObjectHeight} 米`);
        // 计算射线与该物体的相交位置
        const intersection = viewer.scene.pickFromRay(ray, [result]);
        if (intersection && intersection.position) {
          const hitPoint = intersection.position;

          console.log('dronePositionCartesian:', dronePositionCartesian);
          console.log('hitPoint:', hitPoint);

          cartographicHit = Cesium.Cartographic.fromCartesian(hitPoint);
          console.log('碰撞点经度:', Cesium.Math.toDegrees(cartographicHit.longitude));
          console.log('碰撞点纬度:', Cesium.Math.toDegrees(cartographicHit.latitude));
          console.log('碰撞点高度:', cartographicHit.height);
          distance = Cesium.Cartesian3.distance(dronePositionCartesian, hitPoint);

          console.log(`📏 无人机到该物体的距离: ${distance.toFixed(2)} 米`);

          if (distance < 500) {
            console.log("🎨 符合条件，修改颜色");
            result.color = Cesium.Color.BLUE.withAlpha(0.5);
            changedCount++;

            // 直接改变建筑物颜色（而不是加红点）
            //result.color = Cesium.Color.BLUE.withAlpha(0.5);
            // 可视化命中点
            viewer.entities.add({
              position: hitPoint,
              point: {
                pixelSize: 50,
                color: Cesium.Color.RED
              }
            });
          } else {
            console.log("⚠️ 距离大于200m，跳过");
          }
        }
        //}
      }

      if (changedCount === 0) {
        console.log("✅ 射线穿透但无建筑物距离<200m");
        result = {
          collision: false,
        };
      }

      result = {
        collision: true,
        hitpointHeight: cartographicHit.height,
        hitDistance: distance,
        hitObjectHeight: hitObjectHeight
      };
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
  console.log("接收到请求check-collision");
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