export interface PromotionRect { x: number; y: number; width: number; height: number }
export interface PromotionLayout { logo: PromotionRect; title: PromotionRect }
export function validPromotionLayout(layout: PromotionLayout): boolean {
  return [layout.logo, layout.title].every((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= 1 && rect.y + rect.height <= 1);
}
