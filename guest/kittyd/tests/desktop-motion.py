#!/usr/bin/env python3
"""Synthetic continuous updates with an in-picture source timestamp (no user data)."""
import time
import tkinter as tk
root = tk.Tk()
root.overrideredirect(True)
root.geometry('1280x800+0+0')
canvas = tk.Canvas(root, width=1280, height=800, highlightthickness=0, bg='#111821')
canvas.pack(fill='both', expand=True)
canvas.create_text(40, 40, anchor='nw', text='Kitties · continuous video fixture', fill='white', font=('DejaVu Sans', 24))
canvas.create_text(40, 90, anchor='nw', text='Synthetic updates · timestamp encoded below · no user data', fill='#9daebe', font=('DejaVu Sans', 16))
bits = [canvas.create_rectangle(40 + bit * 24, 140, 64 + bit * 24, 172, outline='') for bit in range(32)]
ball = canvas.create_oval(50, 260, 170, 380, fill='#82dcb0', outline='')
count = 0

def update():
    global count
    stamp = int(time.time() * 1000) & 0xffffffff
    for bit, rect in enumerate(bits):
        canvas.itemconfigure(rect, fill='white' if stamp & (1 << bit) else 'black')
    x = 50 + (count * 12) % 1000
    canvas.coords(ball, x, 260, x + 120, 380)
    count += 1
    root.after(16, update)

update()
root.mainloop()
