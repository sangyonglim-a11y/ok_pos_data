# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = collect_data_files('certifi')
hiddenimports = ['xlrd', 'okpos_crawler']
hiddenimports += collect_submodules('selenium')
hiddenimports += collect_submodules('webdriver_manager')
hiddenimports += collect_submodules('google.auth')
hiddenimports += collect_submodules('google.oauth2')
hiddenimports += collect_submodules('gspread')

a = Analysis(
    ['store_agent.py'],
    pathex=['..'],
    binaries=[],
    datas=datas + [('config.example.json', '.')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='okpos_agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
