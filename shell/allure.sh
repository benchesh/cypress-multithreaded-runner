#!/bin/bash

cd "$1"

if [[ $2 == true ]]; then
    allure generate allure-results --clean -o allure-report &
    allure generate allure-results --clean -o allure-report-temp --single-file
    wait
else
    allure generate allure-results --clean -o allure-report
fi
