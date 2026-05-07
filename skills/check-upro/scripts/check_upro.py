#!/usr/bin/env python3
"""Check current UPRO position (shares and average price)."""

import logging
from ib_insync import *

logging.basicConfig(level=logging.WARNING)
logging.getLogger('ib_insync.Decoder').setLevel(logging.CRITICAL)

ib = IB()

def check_upro_position():
    """Check UPRO position."""
    if not ib.isConnected():
        try:
            ib.connect('127.0.0.1', 4002, clientId=0)
            print("Connected to IB Gateway.")
        except Exception as e:
            print(f"Connection failed: {e}")
            return

    try:
        contract = Stock('UPRO', 'SMART', 'USD')
        ib.qualifyContracts(contract)

        positions = ib.positions()
        
        upro_positions = [p for p in positions if p.contract.symbol == 'UPRO']
        
        # Get current price
        ticker = ib.reqTickers(contract)[0]
        current_price = ticker.ask if ticker.ask else ticker.last
        
        if upro_positions:
            for pos in upro_positions:
                print(f"Shares: {pos.position}")
                print(f"Average Price: ${pos.avgCost:.2f}")
                if current_price:
                    print(f"Current Price: ${current_price:.2f}")
                    pnl = (current_price - pos.avgCost) * pos.position
                    pnl_pct = ((current_price / pos.avgCost) - 1) * 100
                    print(f"Unrealized P&L: ${pnl:,.2f} ({pnl_pct:+.2f}%)")
        else:
            print("No UPRO position found.")
            if current_price:
                print(f"Current UPRO Price: ${current_price:.2f}")

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_upro_position()
    ib.disconnect()
