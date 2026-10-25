// クラフト（自前）。mineflayer の bot.craft は 1.21.4 で、材料を置く途中に「手に持っている物」の把握がずれて
// 「missing ingredient」になったり、余りをクラフト欄に置き去りにして消したりする。
// ここでは材料を1つずつ置き、クリックのたびにサーバーの反映を待つ。最後に画面を閉じて余りを持ち物に戻させる。
export async function craftOnce (bot, recipe, table) {
  const window = table ? await bot.openBlock(table) : bot.inventory
  const width = table ? 3 : 2
  const slotFor = (x, y) => 1 + x + y * width
  const click = async (slot, button, mode) => {
    await bot.clickWindow(slot, button, mode)
    await bot.waitForTicks(1)
  }

  // 置く場所: 形のあるレシピは形どおり、形のないレシピは左上から順に
  const cells = []
  if (recipe.inShape) {
    recipe.inShape.forEach((row, y) => row.forEach((ing, x) => {
      if (ing && ing.id !== -1) cells.push({ slot: slotFor(x, y), id: ing.id })
    }))
  } else {
    recipe.ingredients.forEach((ing, i) => cells.push({ slot: slotFor(i % width, Math.floor(i / width)), id: ing.id }))
  }

  try {
    for (const id of [...new Set(cells.map((c) => c.id))]) {
      let source = null
      for (const cell of cells.filter((c) => c.id === id)) {
        if (!window.selectedItem || window.selectedItem.type !== id) {
          source = window.findInventoryItem(id, null)
          if (!source) throw new Error(`missing ingredient ${bot.registry.items[id]?.name}`)
          await click(source.slot, 0, 0) // 束ごと持つ
        }
        await click(cell.slot, 1, 0) // 右クリックで1つ置く
      }
      if (window.selectedItem) {
        const back = source?.slot ?? window.firstEmptyInventorySlot()
        await click(back, 0, 0) // 余りを元の場所に戻す
      }
    }
    await bot.waitForTicks(2)
    await click(0, 0, 1) // できたものをシフトクリックで持ち物へ
  } finally {
    if (table) bot.closeWindow(window)
    else bot._client.write('close_window', { windowId: 0 })
    await bot.waitForTicks(4)
  }
}
