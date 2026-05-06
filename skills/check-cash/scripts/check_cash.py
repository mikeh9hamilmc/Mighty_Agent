#!/usr/bin/env python3
"""Check account cash and positions."""

import logging
from ib_insync import *

logging.basicConfig(level=logging.WARNING)
logging.getLogger('ib_insync.Decoder').setLevel(logging.CRITICAL)

ib = IB()

def check_account():
    """Check account cash and positions."""
    if not ib.isConnected():
        try:
            ib.connect('127.0.0.1', 4002, clientId=0)
            print("Connected to IB Gateway.")
        except Exception as e:
            print(f"Connection failed: {e}")
            return

    try:
        account = ib.accountValues()
        
        # Get cash and net liquidation
        cash = {}
        for av in account:
            if av.tag == 'CashBalance' and av.currency == 'USD':
                cash['cash'] = float(av.value)
            if av.tag == 'NetLiquidation' and av.currency == 'USD':
                cash['net_liq'] = float(av.value)
            if av.tag == 'BuyingPower' and av.currency == 'USD':
                cash['buying_power'] = float(av.value)
        
        # Get positions
        positions = ib.positions()
        
        # Calculate positions value
        positions_value = 0
        for pos in positions:
            if pos.contract.currency != 'USD':
                continue
            # Use avgCost * position to estimate
            if pos.avgCost and pos.position:
                positions_value += pos.avgCost * abs(pos.position)
        
        cash_value = cash.get('cash', 0)
        net_liq = cash.get('net_liq', 0)
        
        print(f"\nCash: ${cash_value:,.2f}")
        print(f"Net Liquidation: ${net_liq:,.2f}")
        
        if 'buying_power' in cash:
            print(f"Buying Power: ${cash['buying_power']:,.2f}")
        
        if net_liq > 0:
            cash_pct = (cash_value / net_liq) * 100
            print(f"\nCash Percentage: {cash_pct:.1f}%")

    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_account()
    ib.disconnect()
