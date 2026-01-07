import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

export async function GET() {
  try {
    // Get platform
    const platform = os.platform();
    const isWindows = platform === 'win32';

    // Check if nvidia-smi is available
    const hasNvidiaSmi = await checkNvidiaSmi(isWindows);
    const hasAmdSmi = await checkAMDSmi(isWindows);

    if (!hasNvidiaSmi && !hasAmdSmi) {
      return NextResponse.json({
        hasNvidiaSmi: false,
        gpus: [],
        error: 'nvidia-smi not found or not accessible',
      });
    }

    // Get GPU stats
    if (hasNvidiaSmi) {
      const gpuStats = await getGpuStats(isWindows);
      return NextResponse.json({
        hasNvidiaSmi: true,
        gpus: gpuStats,
      });
    } else {
      const gpuStats = await getAMDGpuStats(isWindows);
      return NextResponse.json({
        hasNvidiaSmi: true,
        gpus: gpuStats,
      });
    }

  } catch (error) {
    console.error('Error fetching GPU stats:', error);
    return NextResponse.json(
      {
        hasNvidiaSmi: false,
        gpus: [],
        error: `Failed to fetch GPU stats: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
}

async function checkNvidiaSmi(isWindows: boolean): Promise<boolean> {
  try {
    if (isWindows) {
      // Check if nvidia-smi is available on Windows
      // It's typically located in C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe
      // but we'll just try to run it directly as it may be in PATH
      await execAsync('nvidia-smi -L');
    } else {
      // Linux/macOS check
      await execAsync('which nvidia-smi');
    }
    return true;
  } catch (error) {
    return false;
  }
}
async function checkAMDSmi(isWindows: boolean): Promise<boolean> {
  try {
    if (!isWindows) {
      // Linux/macOS check
      await execAsync('which amd-smi');
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function getGpuStats(isWindows: boolean) {
  // Command is the same for both platforms, but the path might be different
  const command =
    'nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.free,memory.used,power.draw,power.limit,clocks.current.graphics,clocks.current.memory,fan.speed --format=csv,noheader,nounits';

  // Execute command
  const { stdout } = await execAsync(command, {
    env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
  });

  // Parse CSV output
  const gpus = stdout
    .trim()
    .split('\n')
    .map(line => {
      const [
        index,
        name,
        driverVersion,
        temperature,
        gpuUtil,
        memoryUtil,
        memoryTotal,
        memoryFree,
        memoryUsed,
        powerDraw,
        powerLimit,
        clockGraphics,
        clockMemory,
        fanSpeed,
      ] = line.split(', ').map(item => item.trim());

      return {
        index: parseInt(index),
        name,
        driverVersion,
        temperature: parseInt(temperature),
        utilization: {
          gpu: parseInt(gpuUtil),
          memory: parseInt(memoryUtil),
        },
        memory: {
          total: parseInt(memoryTotal),
          free: parseInt(memoryFree),
          used: parseInt(memoryUsed),
        },
        power: {
          draw: parseFloat(powerDraw),
          limit: parseFloat(powerLimit),
        },
        clocks: {
          graphics: parseInt(clockGraphics),
          memory: parseInt(clockMemory),
        },
        fan: {
          speed: parseInt(fanSpeed) || 0, // Some GPUs might not report fan speed, default to 0
        },
      };
    });

  return gpus;
}

function amdParseFloat(value) {
    try {
        if (value === "N/A" || value === undefined || value === null) {
            return 0.0;
        }
        const parsedValue = typeof value === 'object' && 'value' in value ? value.value : value;
        const ret = parseFloat(parsedValue);
        return isNaN(ret) ? 0.0 : ret;
    } catch(error) {
        return 0.0;
    }
}

function amdParseInt(value) {
    try {
        if (value === "N/A" || value === undefined || value === null) {
            return 0;
        }
        const parsedValue = typeof value === 'object' && 'value' in value ? value.value : value;
        const ret = parseInt(parsedValue);
        return isNaN(ret) ? 0 : ret;
    } catch(error) {
        return 0;
    }
}

async function getAMDGpuStats(isWindows: boolean) {
  // Execute command
  const command = 'amd-smi static --json && echo ";" && amd-smi metric --json';
  // Execute command
  const { stdout } = await execAsync(command, {
    env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
  });
  var data = stdout.split(';');

  var sdata = {};
  var mdata = {};
  try {
      sdata = JSON.parse(data[0]);
      mdata = JSON.parse(data[1]);
  } catch (error) {
    console.error('Failed to parse output of amd-smi returned json: ', error);
    return [];
  }

  var gpus = sdata["gpu_data"].map(d => {
    const i = amdParseInt(d["gpu"]);
    const gpu_data = mdata["gpu_data"][i];

    const temperatureData = gpu_data["temperature"]?.["hotspot"];
    const temperature = amdParseInt(temperatureData);

    const usageData = gpu_data["usage"];
    const gpu_util = amdParseInt(usageData?.["gfx_activity"] ?? 0);

    const mem_usage = gpu_data["mem_usage"] || {};
    const mem_total = amdParseFloat(mem_usage["total_vram"]);
    const mem_used = amdParseFloat(mem_usage["used_vram"]);
    const mem_free = amdParseFloat(mem_usage["free_visible_vram"]);
    const mem_utilization = mem_total > 0 ? ((mem_used / mem_total) * 100) : 0;

    const powerData = gpu_data["power"] || {};
    const power_draw = amdParseFloat(powerData["socket_power"]);
    const limitData = d["limit"] || {};
    const power_limit = amdParseFloat(limitData["max_power"]);

    const clockData = gpu_data["clock"] || {};
    const gfx_clock = amdParseInt(clockData["gfx_0"]?.["clk"]);
    const mem_clock = amdParseInt(clockData["mem_0"]?.["clk"]);

    const fanData = gpu_data["fan"] || {};
    const fan_speed = amdParseFloat(fanData["usage"]);

    return {
      index: i,
      name: d["asic"]["market_name"],
      driverVersion: d["driver"]["version"],
      temperature: temperature,
      utilization: {
        gpu: gpu_util,
        memory: mem_utilization,
      },
      memory: {
        total: mem_total,
        used: mem_used,
        free: mem_free,
      },
      power: {
        draw: power_draw,
        limit: power_limit,
      },
      clocks: {
        graphics: gfx_clock,
        memory: mem_clock,
      },
      fan: {
        speed: fan_speed,
      }
    };
  });

  return gpus;
}
