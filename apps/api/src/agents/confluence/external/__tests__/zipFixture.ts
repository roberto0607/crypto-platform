/** Test helpers: a minimal one-entry zip, and a Binance-style metrics day file. */
import { deflateRawSync } from "node:zlib";

/** Local header + data + central directory + end record. */
export function makeZip(name: string, data: Buffer, method: 0 | 8 = 8): Buffer {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(local.length + nameBuf.length + body.length, 16);
  return Buffer.concat([local, nameBuf, body, central, nameBuf, end]);
}

/** 5-minute rows, each written twice like the real archive files. */
export function makeMetricsZip(day: string): Buffer {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000;
  const lines = ["create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio"];
  for (let i = 0; i < 288; i++) {
    const t = new Date((start + i * 300) * 1000).toISOString().replace("T", " ").slice(0, 19);
    const row = `${t},BTCUSDT,1000,${(1e9 + start / 100 + i).toFixed(4)},1,1,1,1`;
    lines.push(row, row);
  }
  return makeZip(`BTCUSDT-metrics-${day}.csv`, Buffer.from(`${lines.join("\n")}\n`));
}
