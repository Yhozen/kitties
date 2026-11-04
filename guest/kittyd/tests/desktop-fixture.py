#!/usr/bin/env python3
"""Synthetic, non-private desktop for browser latency acceptance at 1280x800."""
import tkinter as tk

root = tk.Tk()
root.overrideredirect(True)
root.geometry("1280x800+0+0")
canvas = tk.Canvas(root, width=1280, height=800, highlightthickness=0, bg="#111821")
canvas.pack(fill="both", expand=True)
count = 0

def draw():
    canvas.delete("all")
    canvas.create_text(40, 35, anchor="nw", text="Kitties · desktop latency fixture", fill="#e7eef5", font=("DejaVu Sans", 24, "bold"))
    canvas.create_text(40, 85, anchor="nw", text="Synthetic test data · Click anywhere to update", fill="#9daebe", font=("DejaVu Sans", 16))
    for bit in range(16):
        x = 40 + bit * 24
        canvas.create_rectangle(x, 120, x + 24, 152, fill="white" if count & (1 << bit) else "black", outline="")
    canvas.create_rectangle(40, 200, 600, 650, fill="#1b2937", outline="#39516a", width=2)
    canvas.create_text(72, 230, anchor="nw", text="Input received", fill="#e7eef5", font=("DejaVu Sans", 20))
    canvas.create_text(72, 290, anchor="nw", text=str(count), fill="#82dcb0", font=("DejaVu Sans", 80, "bold"))
    canvas.create_rectangle(680, 200, 1190, 650, fill="#366753" if count % 2 else "#563f73", outline="")
    canvas.create_text(720, 245, anchor="nw", text="Live desktop", fill="white", font=("DejaVu Sans", 28, "bold"))
    canvas.create_text(720, 315, anchor="nw", text="Authenticated input\nPersistent guest channel\nNo model calls", fill="#d8e5e0", font=("DejaVu Sans", 18), width=400)
    canvas.create_text(40, 720, anchor="nw", text="1280 × 800 · same fixture for JPEG and H.264", fill="#9daebe", font=("DejaVu Sans", 16))

def click(_):
    global count
    count += 1
    draw()

canvas.bind("<Button-1>", click)
draw()
root.mainloop()
