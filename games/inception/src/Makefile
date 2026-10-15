LOGIN = samaouch
DATA_PATH = /home/$(LOGIN)/data
COMPOSE_FILE = ./srcs/docker-compose.yml

RM := rm -rf

BOLD := \033[1m
GREEN := \033[0;32m
RED := \033[0;31m
BLUE := \033[0;34m
MAGENTA := \033[0;35m
CYAN    := \033[0;36m
YELLOW := \033[0;33m
END := \033[0m

CHECKMARK := "✔️"
WARNING := "⚠️"
FIRE := "🔥"
OK := "✅"
CLEAN := "🧹"
BUILD := "🛠️"
SUCCESS := "🎉"
DONE := "🏁"

ARGS = $(filter-out logs, $(MAKECMDGOALS))

all: setup
	@docker compose -f $(COMPOSE_FILE) up -d --build
	

setup:
	@echo "$(GREEN)$(BOLD)$(BUILD) Volume setup  $(BUILD)$(DATA_PATH). $(END)"
	@if [ ! -d "$(DATA_PATH)/mariadb" ]; then \
		mkdir -p "$(DATA_PATH)/mariadb"; \
	fi
	
	@if [ ! -d "$(DATA_PATH)/wordpress" ]; then \
		mkdir -p "$(DATA_PATH)/wordpress"; \
	fi
	@if [ ! -d "$(DATA_PATH)/redis" ]; then \
		mkdir -p "$(DATA_PATH)/redis"; \
	fi

status:
	@echo "$(MAGENTA)$(BOLD)$(FIRE) Containers status $(END) $(FIRE)"
	@docker ps -a

logs:
	@if [ -z "$(ARGS)" ]; then \
		echo "Usage: make logs <container_name>"; \
	else \
		docker compose -f ./srcs/docker-compose.yml logs $(ARGS); \
	fi

%:
	@:

stop:
	@docker compose -f $(COMPOSE_FILE) stop

down:
	@docker compose -f $(COMPOSE_FILE) down

network:
	@docker network ls | grep inception || echo "No inception network found"
	
volume: 
	@docker volume ls

clean:
	@docker compose -f $(COMPOSE_FILE) down
	@echo "$(YELLOW)$(BOLD)$(CLEAN)Shutting down containers $(OK)$(END)"

fclean:
	@docker compose -f $(COMPOSE_FILE) down -v --rmi all
	@docker system prune -af
	@sudo $(RM) $(DATA_PATH)/mariadb
	@sudo $(RM) $(DATA_PATH)/wordpress
	@sudo $(RM) $(DATA_PATH)/redis
	@echo "$(YELLOW)$(BOLD)$(CLEAN)Full Cleanup (Containers, Images & Volumes) !$(DONE)$(END)"

re: fclean all

.PHONY: all clean fclean re setup status logs stop down up restart
