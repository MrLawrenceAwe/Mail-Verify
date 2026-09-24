#!/bin/zsh
cd -- "${0:A:h}"
python3 companion/install.py
result=$?
echo
if (( result != 0 )); then echo 'Installation failed. See the message above.'; fi
read '?Press Return to close…'
