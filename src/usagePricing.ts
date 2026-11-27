import { getPool } from "./db.js";
import { HttpError } from "./httpError.js";
import { usageLabel } from "./usageRecord.js";

export async function usagePrices() {
  return (
    await getPool().query(
      `SELECT model, input_rate AS input, output_rate AS output, read_rate AS "cacheRead", write_rate AS "cacheWrite" FROM usage_prices ORDER BY model`,
    )
  ).rows;
}

export async function setUsagePrice(body: Record<string, unknown>, remove = false) {
  const model = usageLabel(body.model);
  if (!model) throw new HttpError(400, "请输入有效的模型 ID");
  if (remove) {
    await getPool().query("DELETE FROM usage_prices WHERE model = $1", [model]);
  } else {
    const rates = [body.input, body.output, body.cacheRead, body.cacheWrite];
    if (rates.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1_000_000))
      throw new HttpError(400, "四项单价须为 0 至 1,000,000 的数值（USD / 百万 Tokens）");
    await getPool().query(
      `INSERT INTO usage_prices (model,input_rate,output_rate,read_rate,write_rate) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(model) DO UPDATE SET input_rate=excluded.input_rate, output_rate=excluded.output_rate, read_rate=excluded.read_rate, write_rate=excluded.write_rate`,
      [model, ...rates],
    );
  }
  return usagePrices();
}
