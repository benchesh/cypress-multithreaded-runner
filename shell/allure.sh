#!/bin/bash

cd "$1"

if [[ $3 == true ]]; then
    "$2" generate allure-results --clean -o allure-report &
    "$2" generate allure-results --clean -o allure-report-temp --single-file
    wait
else
    "$2" generate allure-results --clean -o allure-report
fi
